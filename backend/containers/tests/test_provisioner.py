"""seam: HomeProvisioner —— cp -a 预填充容器 home（spec §5.6）。

出处：docs/FULLSTACK-REFACTOR-SPEC.md §5.6「控制面直接在宿主 cp -a template/researcher/.
instances/<name>/home/（宿主路径可达，无需 init 容器）」。bind-mount home 决策下，预填充
= 控制面宿主 shutil.copytree（保留符号链接，对齐 cp -a）。
"""
import os

import pytest

from containers.provisioner import HomeProvisioner


def _seed(template):
    (template / 'workspace').mkdir(parents=True)
    (template / 'workspace' / 'note.md').write_text('hi')
    (template / 'wiki').mkdir()
    (template / 'wiki' / 'main').mkdir()


def test_provision_copies_template_tree(tmp_path):
    # spec §5.6：新 home 由控制面 cp -a 预填充
    template = tmp_path / 'template'
    _seed(template)
    home = tmp_path / 'home'

    HomeProvisioner(template).provision(home)

    assert (home / 'workspace' / 'note.md').read_text() == 'hi'
    assert (home / 'wiki' / 'main').is_dir()


def test_provision_preserves_symlinks_like_cp_a(tmp_path):
    # cp -a = archive mode（含 --no-dereference，保留符号链接而非跟随拷贝目标）
    template = tmp_path / 'template'
    _seed(template)
    os.symlink('workspace/note.md', template / 'link.md')
    home = tmp_path / 'home'

    HomeProvisioner(template).provision(home)

    assert (home / 'link.md').is_symlink()
    assert os.readlink(home / 'link.md') == 'workspace/note.md'


def test_provision_fails_if_home_already_exists(tmp_path):
    # fail-fast：home 已存在 = 重名残留或并发，不静默覆盖（spec §5.5 失败回滚前置）
    template = tmp_path / 'template'
    template.mkdir()
    home = tmp_path / 'home'
    home.mkdir()
    with pytest.raises(FileExistsError):
        HomeProvisioner(template).provision(home)


def test_provision_fails_if_template_missing(tmp_path):
    # 模板目录不存在 = 部署未配（OPENCLAW_FLEET TEMPLATE），fail-fast 而非产空 home
    with pytest.raises(FileNotFoundError):
        HomeProvisioner(tmp_path / 'nope').provision(tmp_path / 'home')
