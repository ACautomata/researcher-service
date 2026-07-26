"""Django 模型的应用层凭证加密字段。"""
from django.conf import settings
from django.db import models
from django.db.models.expressions import BaseExpression
from django.db.models.query import ValuesIterable, ValuesListIterable
from django.db.models.utils import create_namedtuple_class

from security.credential_cipher import CredentialCipher


class EncryptedTextField(models.TextField):
    """存储密文、向模型调用方暴露明文的 expand 阶段文本字段。"""

    def __init__(self, *args, state_field: str, **kwargs):
        self.state_field = state_field
        super().__init__(*args, **kwargs)

    def deconstruct(self):
        name, path, args, kwargs = super().deconstruct()
        kwargs['state_field'] = self.state_field
        return name, path, args, kwargs

    def get_prep_value(self, value):
        prepared = models.TextField.to_python(self, value)
        if prepared is None:
            return None
        return self._cipher().encrypt(prepared)

    def from_db_value(self, value, expression, connection):
        return value

    def to_python(self, value):
        return models.TextField.to_python(self, value)

    def _cipher(self) -> CredentialCipher:
        return CredentialCipher(settings.CREDENTIAL_ENCRYPTION_KEYS)

    def decrypt_value(self, value):
        return self._cipher().decrypt(value)


class EncryptedValuesIterable(ValuesIterable):
    def __iter__(self):
        for row in super().__iter__():
            yield self.queryset._decrypt_projection_dict(row)


class EncryptedValuesListIterable(ValuesListIterable):
    def __iter__(self):
        for row in super().__iter__():
            values = list(row)
            for value_index, state_index, field in self.queryset._credential_projection:
                if values[value_index] is not None:
                    values[value_index] = field.decrypt_value(values[value_index])
            result = tuple(
                value for index, value in enumerate(values)
                if index not in self.queryset._projection_state_indexes
            )
            if self.queryset._projection_flat:
                yield result[0]
            elif self.queryset._projection_named:
                visible_fields = list(self.queryset._projection_visible_fields)
                visible_fields.extend(
                    name for name in self.queryset.query.annotation_select
                    if name not in visible_fields
                )
                yield create_namedtuple_class(*visible_fields)(*result)
            else:
                yield result


class EncryptedCredentialQuerySet(models.QuerySet):
    def _clone(self):
        clone = super()._clone()
        for attribute in (
            '_projection_protected_fields', '_projection_added_state_fields',
            '_credential_projection', '_projection_state_indexes', '_projection_flat',
            '_projection_named', '_projection_visible_fields',
        ):
            if hasattr(self, attribute):
                setattr(clone, attribute, getattr(self, attribute))
        return clone

    def _protected_projection_fields(self, fields):
        requested = set(fields)
        return [
            field for field in self.model._meta.fields
            if isinstance(field, EncryptedTextField) and field.name in requested
        ]

    def _is_protected_lookup(self, field_name):
        if not isinstance(field_name, str):
            return False
        model = self.model
        path = field_name.split('__')
        for index, part in enumerate(path):
            try:
                field = model._meta.get_field(part)
            except models.FieldDoesNotExist:
                return False
            if index == len(path) - 1:
                return isinstance(field, EncryptedTextField)
            if not field.is_relation:
                return False
            model = field.related_model
        return False

    def only(self, *fields):
        if not fields:
            return super().only()
        selected = list(fields)
        for field in self.model._meta.fields:
            if isinstance(field, EncryptedTextField):
                if field.name not in selected:
                    selected.append(field.name)
                if field.state_field not in selected:
                    selected.append(field.state_field)
        return super().only(*selected)

    def defer(self, *fields):
        protected_states = {
            name for field in self.model._meta.fields
            if isinstance(field, EncryptedTextField)
            for name in (field.name, field.state_field)
        }
        if protected_states & set(fields):
            raise ValueError('encrypted credential state fields cannot be deferred')
        return super().defer(*fields)

    def _projection_fields(self, fields):
        protected = self._protected_projection_fields(fields)
        added_states = [field.state_field for field in protected if field.state_field not in fields]
        return tuple(fields) + tuple(added_states), protected, added_states

    def _decrypt_projection_dict(self, row):
        for field in self._projection_protected_fields:
            if row[field.name] is not None:
                row[field.name] = field.decrypt_value(row[field.name])
        for state_field in self._projection_added_state_fields:
            row.pop(state_field)
        return row

    def values(self, *fields, **expressions):
        protected_names = {
            field.name for field in self.model._meta.fields
            if isinstance(field, EncryptedTextField)
        }
        if any(
            self._expression_references_protected_field(expression, protected_names)
            for expression in (*fields, *expressions.values())
        ) or any('__' in field and self._is_protected_lookup(field) for field in fields if isinstance(field, str)):
            raise ValueError('credential expressions cannot be projected')
        self._reject_credential_annotation_aliases(fields)
        if not fields and not expressions:
            fields = tuple(field.name for field in self.model._meta.concrete_fields)
        if not fields:
            return super().values(*fields, **expressions)
        selected, protected, added_states = self._projection_fields(fields)
        if protected and self.query.distinct:
            raise ValueError('distinct credential projections are not supported')
        queryset = super().values(*selected, **expressions)
        if protected:
            queryset._iterable_class = EncryptedValuesIterable
            queryset._projection_protected_fields = protected
            queryset._projection_added_state_fields = added_states
        return queryset

    def _expression_references_protected_field(self, expression, protected_names):
        if getattr(expression, 'name', None) in protected_names:
            return True
        if not hasattr(expression, 'get_source_expressions'):
            return False
        return any(
            self._expression_references_protected_field(child, protected_names)
            for child in expression.get_source_expressions()
        )

    def values_list(self, *fields, flat=False, named=False):
        protected_names = {
            field.name for field in self.model._meta.fields
            if isinstance(field, EncryptedTextField)
        }
        if flat and named:
            raise TypeError("'flat' and 'named' can't be used together.")
        if flat and len(fields) > 1:
            raise TypeError("'flat' is not valid when values_list is called with more than one field.")
        if any(
            self._expression_references_protected_field(field, protected_names)
            for field in fields
        ) or any('__' in field and self._is_protected_lookup(field) for field in fields if isinstance(field, str)):
            raise ValueError('credential expressions cannot be projected')
        self._reject_credential_annotation_aliases(fields)
        if not fields:
            fields = tuple(field.name for field in self.model._meta.concrete_fields)
        selected, protected, added_states = self._projection_fields(fields)
        if protected and self.query.distinct:
            raise ValueError('distinct credential projections are not supported')
        if not protected:
            return super().values_list(*fields, flat=flat, named=named)
        queryset = super().values_list(*selected)
        if protected:
            queryset._iterable_class = EncryptedValuesListIterable
            queryset._credential_projection = [
                (fields.index(field.name), selected.index(field.state_field), field)
                for field in protected
            ]
            queryset._projection_state_indexes = [
                selected.index(state_field) for state_field in added_states
            ]
            queryset._projection_flat = flat
            queryset._projection_named = named
            queryset._projection_visible_fields = queryset._fields[:len(fields)]
        return queryset

    def _reject_credential_annotation_aliases(self, fields):
        protected_names = {
            field.name for field in self.model._meta.fields
            if isinstance(field, EncryptedTextField)
        }
        annotations = self.query.annotations
        if any(
            field in annotations
            and self._expression_references_protected_field(annotations[field], protected_names)
            for field in fields
        ):
            raise ValueError('credential expressions cannot be projected')
    def update(self, **kwargs):
        for field in self.model._meta.fields:
            if isinstance(field, EncryptedTextField) and field.name in kwargs:
                if isinstance(kwargs[field.name], BaseExpression) or hasattr(
                    kwargs[field.name], 'resolve_expression'
                ):
                    raise ValueError(f'{field.name} does not support expression updates')
                kwargs[field.state_field] = True
        return super().update(**kwargs)

    def bulk_update(self, objs, fields, batch_size=None):
        protected_fields = {
            field.name for field in self.model._meta.fields
            if isinstance(field, EncryptedTextField)
        }
        if protected_fields & set(fields):
            raise ValueError('bulk_update does not support encrypted credential fields')
        return super().bulk_update(objs, fields, batch_size=batch_size)

    def bulk_create(self, objs, **kwargs):
        objects = list(objs)
        update_fields = kwargs.get('update_fields')
        state_fields = []
        for obj in objects:
            for field in obj._meta.fields:
                if isinstance(field, EncryptedTextField):
                    setattr(obj, field.state_field, True)
                    if update_fields and field.name in update_fields:
                        state_fields.append(field.state_field)
        if update_fields:
            kwargs['update_fields'] = list(dict.fromkeys([*update_fields, *state_fields]))
        return super().bulk_create(objects, **kwargs)

    def distinct(self, *field_names):
        if getattr(self, '_projection_protected_fields', ()) or getattr(
            self, '_credential_projection', ()
        ):
            raise ValueError('distinct credential projections are not supported')
        return super().distinct(*field_names)


class EncryptedCredentialManager(models.Manager.from_queryset(EncryptedCredentialQuerySet)):
    pass


class EncryptedCredentialsModel(models.Model):
    """为带显式密文状态列的模型提供透明读取和双写状态更新。"""

    objects = EncryptedCredentialManager()

    class Meta:
        abstract = True

    @classmethod
    def from_db(cls, db, field_names, values):
        instance = super().from_db(db, field_names, values)
        for field in instance._meta.fields:
            if isinstance(field, EncryptedTextField) and field.attname in field_names:
                value = instance.__dict__[field.attname]
                if value is not None:
                    instance.__dict__[field.attname] = field.decrypt_value(value)
        return instance

    def save(self, *args, **kwargs):
        update_fields = kwargs.get('update_fields')
        selected_fields = set(update_fields) if update_fields is not None else None
        state_fields = set()
        for field in self._meta.fields:
            if not isinstance(field, EncryptedTextField):
                continue
            if selected_fields is None or field.name in selected_fields:
                setattr(self, field.state_field, True)
                state_fields.add(field.state_field)
        if selected_fields is not None:
            kwargs['update_fields'] = selected_fields | state_fields
        return super().save(*args, **kwargs)

    def refresh_from_db(self, using=None, fields=None, from_queryset=None):
        selected_fields = set(fields) if fields is not None else None
        if selected_fields is not None:
            for field in self._meta.fields:
                if isinstance(field, EncryptedTextField) and field.attname in selected_fields:
                    selected_fields.add(field.state_field)
        return super().refresh_from_db(
            using=using, fields=selected_fields, from_queryset=from_queryset,
        )
