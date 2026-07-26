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
                if values[state_index] and values[value_index] is not None:
                    values[value_index] = field.decrypt_value(values[value_index])
            result = tuple(values[:self.queryset._projection_visible_count])
            if self.queryset._projection_flat:
                yield result[0]
            elif self.queryset._projection_named:
                yield create_namedtuple_class(*self.queryset._projection_visible_fields)(*result)
            else:
                yield result


class EncryptedCredentialQuerySet(models.QuerySet):
    def _clone(self):
        clone = super()._clone()
        for attribute in (
            '_projection_protected_fields', '_projection_added_state_fields',
            '_credential_projection', '_projection_visible_count', '_projection_flat',
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

    def only(self, *fields):
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
            if row[field.state_field] and row[field.name] is not None:
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
        ):
            raise ValueError('credential expressions cannot be projected')
        if not fields and not expressions:
            fields = tuple(field.name for field in self.model._meta.concrete_fields)
        if not fields:
            return super().values(*fields, **expressions)
        selected, protected, added_states = self._projection_fields(fields)
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
        if any(
            self._expression_references_protected_field(field, protected_names)
            for field in fields
        ):
            raise ValueError('credential expressions cannot be projected')
        if not fields:
            fields = tuple(field.name for field in self.model._meta.concrete_fields)
        selected, protected, _ = self._projection_fields(fields)
        if not protected:
            return super().values_list(*fields, flat=flat, named=named)
        queryset = super().values_list(*selected)
        if protected:
            queryset._iterable_class = EncryptedValuesListIterable
            queryset._credential_projection = [
                (fields.index(field.name), selected.index(field.state_field), field)
                for field in protected
            ]
            queryset._projection_visible_count = len(fields)
            queryset._projection_flat = flat
            queryset._projection_named = named
            queryset._projection_visible_fields = fields
        return queryset
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


class EncryptedCredentialManager(models.Manager.from_queryset(EncryptedCredentialQuerySet)):
    def bulk_create(self, objs, **kwargs):
        for obj in objs:
            for field in obj._meta.fields:
                if isinstance(field, EncryptedTextField):
                    setattr(obj, field.state_field, True)
        return super().bulk_create(objs, **kwargs)


class EncryptedCredentialsModel(models.Model):
    """为带显式密文状态列的模型提供透明读取和双写状态更新。"""

    objects = EncryptedCredentialManager()

    class Meta:
        abstract = True

    @classmethod
    def from_db(cls, db, field_names, values):
        instance = super().from_db(db, field_names, values)
        for field in instance._meta.fields:
            if isinstance(field, EncryptedTextField) and getattr(instance, field.state_field, False):
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
