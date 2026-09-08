"""Exercise release orchestration with fake tools; never sign or upload anything."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent.parent


class ReleaseTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        for name in ('scripts/release.sh', 'scripts/check-version.py', 'package.json',
                     'src-tauri/tauri.conf.json', 'src-tauri/Cargo.toml', 'src-tauri/Cargo.lock'):
            target = self.root / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(ROOT / name, target)
        self.version = json.loads((self.root / 'package.json').read_text())['version']
        self.bin = self.root / 'bin'
        self.bin.mkdir()
        self.env = {k: v for k, v in os.environ.items()
                    if not k.startswith(('APPLE_', 'TAURI_'))}
        self.env.update(PATH=f'{self.bin}:{os.environ["PATH"]}',
                        TEST_ROOT=str(self.root), TEST_VERSION=self.version)
        (self.root / 'test.key').write_text('fake test key')
        (self.root / '.env.notarization').write_text(
            "APPLE_ID='test@example.invalid'\nAPPLE_PASSWORD='fake'\n"
            "APPLE_TEAM_ID='TEST'\nAPPLE_SIGNING_IDENTITY='Developer ID Application: Test'\n"
            f"TAURI_SIGNING_PRIVATE_KEY_PATH='{self.root}/test.key'\n")
        self.tool('uname', 'case "$1" in -s) echo Darwin;; -m) echo arm64;; esac')
        self.tool('git', '''case "$1" in
status) exit 0;;
rev-parse) case "$2" in v*) exit 1;; HEAD) echo abc123;; *) echo main;; esac;;
fetch|merge-base) exit 0;;
*) exit 90;;
esac''')
        self.tool('gh', '''if [ "$1" = api ]; then
  [ "${TEST_QUERY_FAIL:-}" != 1 ] || exit 1
  [ "${TEST_DUPLICATE:-}" != 1 ] || echo "v$TEST_VERSION"
  exit 0
fi
[ "$1 $2" = 'release create' ] || exit 91
printf '%s\\n' "$@" > "$TEST_ROOT/upload-args"
mkdir -p "$TEST_ROOT/upload"
for arg do [ ! -f "$arg" ] || cp "$arg" "$TEST_ROOT/upload/"; done''')
        self.tool('pnpm', '''mkdir -p dist/native src-tauri/target/release/bundle/macos/Waveform.app src-tauri/target/release/bundle/dmg
[ "${TEST_MISSING_HELPER:-}" = 1 ] || { touch dist/native/waveform-hotkey; chmod +x dist/native/waveform-hotkey; }
printf archive > src-tauri/target/release/bundle/macos/Waveform.app.tar.gz
printf signature > src-tauri/target/release/bundle/macos/Waveform.app.tar.gz.sig
printf dmg > "src-tauri/target/release/bundle/dmg/Waveform_${TEST_VERSION}_aarch64.dmg"''')
        self.tool('codesign', '[ "${TEST_BAD_SIGN:-}" != 1 ]')
        self.tool('xcrun', 'exit 0')
        self.tool('spctl', '[ "${TEST_BAD_GATEKEEPER:-}" != 1 ]')
        finish = self.root / 'scripts/finish-dmg.sh'
        finish.write_text('#!/bin/sh\nset -eu\nmv "$1" "$(dirname "$1")/Waveform-${TEST_VERSION}-arm64.dmg"\n')
        finish.chmod(0o755)

    def tool(self, name, body):
        target = self.bin / name
        target.write_text('#!/bin/sh\nset -eu\n' + body + '\n')
        target.chmod(0o755)

    def run_release(self, **env):
        return subprocess.run(['sh', 'scripts/release.sh'], cwd=self.root,
                              env={**self.env, **env}, capture_output=True, text=True)

    def assert_blocked(self, **env):
        result = self.run_release(**env)
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertFalse((self.root / 'upload-args').exists(), result.stdout)

    def test_draft_assets_match_manifest_and_checksums(self):
        result = self.run_release()
        self.assertEqual(result.returncode, 0, result.stderr)
        args = (self.root / 'upload-args').read_text().splitlines()
        self.assertIn('--draft', args)
        self.assertEqual(args[args.index('--target') + 1], 'abc123')
        assets = self.root / 'upload'
        self.assertEqual(len(list(assets.iterdir())), 5)
        manifest = json.loads((assets / 'latest.json').read_text())
        platform = manifest['platforms']['darwin-aarch64']
        self.assertEqual(manifest['version'], self.version)
        self.assertEqual(platform['signature'], 'signature')
        self.assertTrue(platform['url'].endswith(f'/v{self.version}/Waveform_{self.version}.app.tar.gz'))
        check = subprocess.run(['shasum', '-a', '256', '-c', 'SHA256SUMS'], cwd=assets,
                               capture_output=True, text=True)
        self.assertEqual(check.returncode, 0, check.stdout + check.stderr)

    def test_duplicate_draft_blocks_upload(self):
        self.assert_blocked(TEST_DUPLICATE='1')

    def test_failed_release_query_blocks_upload(self):
        self.assert_blocked(TEST_QUERY_FAIL='1')

    def test_bad_signature_blocks_upload(self):
        self.assert_blocked(TEST_BAD_SIGN='1')

    def test_gatekeeper_failure_blocks_upload(self):
        self.assert_blocked(TEST_BAD_GATEKEEPER='1')

    def test_missing_native_helper_blocks_upload(self):
        self.assert_blocked(TEST_MISSING_HELPER='1')

    def test_stale_lockfile_blocks_upload(self):
        lock = self.root / 'src-tauri/Cargo.lock'
        lock.write_text(lock.read_text().replace(
            f'name = "waveform"\nversion = "{self.version}"',
            'name = "waveform"\nversion = "99.0.0"'))
        self.assert_blocked()


if __name__ == '__main__':
    unittest.main()
