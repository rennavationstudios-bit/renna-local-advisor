"""Exercise exact previous-release upgrades and refusal of customized profiles."""
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

PLUGIN = Path(__file__).resolve().parents[1]
INSTALLER = PLUGIN / 'scripts/install-agents.sh'
FIXTURES = PLUGIN / 'tests/fixtures/v070-renna1'
ROLES = ('luna-implementer', 'sol-reviewer', 'ultraburn-reviewer')
SHELL = shutil.which('sh')


class MigrationTests(unittest.TestCase):
    fixtures = FIXTURES

    def seed(self, target, crlf=False):
        target.mkdir()
        for source in (PLUGIN / 'agents').glob('*.toml'):
            old = self.fixtures / source.name
            content = source.read_bytes()
            if old.exists():
                content = old.read_bytes().replace(b'\r\n', b'\n')
                if crlf:
                    content = content.replace(b'\n', b'\r\n')
            (target / source.name).write_bytes(content)

    def run_installer(self, target, *args):
        self.assertIsNotNone(SHELL, 'sh is required for actual installer coverage')
        return subprocess.run([SHELL, str(INSTALLER), '--target-dir', str(target), *args],
                              capture_output=True, text=True)

    def snapshot(self, target):
        return {p.name: p.read_bytes() for p in target.iterdir()}

    def test_previous_release_lf_and_crlf_upgrade_and_idempotence(self):
        for crlf in (False, True):
            with self.subTest(crlf=crlf), tempfile.TemporaryDirectory() as directory:
                target = Path(directory) / 'agents'
                self.seed(target, crlf)
                before = self.snapshot(target)
                self.assertNotEqual(self.run_installer(target, '--check').returncode, 0)
                self.assertEqual(before, self.snapshot(target), '--check must never mutate')
                result = self.run_installer(target)
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                expected = {p.name: p.read_bytes() for p in (PLUGIN / 'agents').glob('*.toml')}
                self.assertEqual(self.snapshot(target), expected)
                self.assertEqual(self.run_installer(target).returncode, 0)
                self.assertEqual(self.snapshot(target), expected)
                self.assertEqual(self.run_installer(target, '--check').returncode, 0)

    def test_each_customized_previous_role_refuses_entire_upgrade(self):
        for role in ROLES:
            with self.subTest(role=role), tempfile.TemporaryDirectory() as directory:
                target = Path(directory) / 'agents'
                self.seed(target)
                path = target / f'sol-advisor-{role}.toml'
                path.write_bytes(path.read_bytes() + b'\n# user customization\n')
                before = self.snapshot(target)
                result = self.run_installer(target)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('conflict', result.stderr)
                self.assertEqual(before, self.snapshot(target), 'preflight must refuse atomically')

    def test_a_different_roles_digest_is_not_migration_authority(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / 'agents'
            self.seed(target)
            (target / 'sol-advisor-sol-reviewer.toml').write_bytes(
                (self.fixtures / 'sol-advisor-ultraburn-reviewer.toml').read_bytes())
            before = self.snapshot(target)
            self.assertNotEqual(self.run_installer(target).returncode, 0)
            self.assertEqual(before, self.snapshot(target))


class Gpt61MigrationTests(MigrationTests):
    fixtures = PLUGIN / 'tests/fixtures/v080-renna1'


if __name__ == '__main__':
    unittest.main()
