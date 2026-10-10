import hashlib
import importlib.util
import io
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('secure_transfer', Path(__file__).resolve().parents[2] / 'scripts/secure-d1-transfer.py')
transfer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(transfer)
DATA = b'CREATE TABLE synthetic_only (id INTEGER PRIMARY KEY);\n'


class Response(io.BytesIO):
    status = 200

    def __init__(self, payload, headers):
        super().__init__(payload)
        self.headers = headers


class FakeOpener:
    def __init__(self, response):
        self.response = response
        self.requests = []

    def open(self, request, timeout):
        self.requests.append(request)
        if request.get_method() == 'PUT':
            assert request.data.read() == DATA
        return self.response


def ticket(action):
    return {
        'action': action, 'target': 'isolated-synthetic-rehearsal',
        'account_id': transfer.REHEARSAL_ACCOUNT, 'database_id': sorted(transfer.REHEARSAL_DATABASES)[0],
        'url': 'https://' + 'a' * 32 + '.r2.cloudflarestorage.com/synthetic.sql?X-Amz-Signature=synthetic&X-Amz-Credential=synthetic',
        'etag': hashlib.md5(DATA).hexdigest(),
    }


class SecureTransferTests(unittest.TestCase):
    def test_private_download_and_upload_preserve_exact_bytes_without_overwriting(self):
        with tempfile.TemporaryDirectory(prefix='2048-synthetic-backup-') as directory:
            opener = FakeOpener(Response(DATA, {'Content-Length': str(len(DATA))}))
            evidence = transfer.transfer(ticket('download'), 'download', directory, 'synthetic.sql', opener)
            path = Path(directory) / 'synthetic.sql'
            self.assertEqual(path.read_bytes(), DATA)
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            self.assertEqual(evidence['sha256'], hashlib.sha256(DATA).hexdigest())
            self.assertNotIn('url', evidence)
            with self.assertRaises(ValueError):
                transfer.transfer(ticket('download'), 'download', directory, 'synthetic.sql', opener)
            upload = FakeOpener(Response(b'', {'ETag': '"' + evidence['etag'] + '"'}))
            self.assertEqual(transfer.transfer(ticket('upload'), 'upload', directory, 'synthetic.sql', upload)['etag'], evidence['etag'])
            self.assertEqual(path.read_bytes(), DATA)

    def test_short_download_and_wrong_upload_hash_never_create_or_alter_a_valid_backup(self):
        with tempfile.TemporaryDirectory(prefix='2048-synthetic-backup-') as directory:
            with self.assertRaises(ValueError):
                transfer.transfer(ticket('download'), 'download', directory, 'short.sql', FakeOpener(Response(DATA, {'Content-Length': str(len(DATA) + 1)})))
            self.assertFalse((Path(directory) / 'short.sql').exists())
            self.assertTrue(list(Path(directory).glob('*.incomplete')))
            path = Path(directory) / 'synthetic.sql'; path.write_bytes(DATA); path.chmod(0o600)
            bad = ticket('upload'); bad['etag'] = '0' * 32
            with self.assertRaises(ValueError):
                transfer.transfer(bad, 'upload', directory, path.name, FakeOpener(Response(b'', {})))
            self.assertEqual(path.read_bytes(), DATA)

    def test_wrong_target_insecure_url_git_checkout_and_unconfirmed_freeze_are_rejected(self):
        for change in [
            {'url': 'http://example.com/secret'},
            {'url': ticket('download')['url'].replace('.com/', '.com.evil.example/')},
            {'database_id': transfer.PRODUCTION['old-production'][1]},
            {'target': 'old-production', 'account_id': transfer.PRODUCTION['old-production'][0], 'database_id': transfer.PRODUCTION['old-production'][1]},
        ]:
            bad = {**ticket('download'), **change}
            with self.assertRaises(ValueError): transfer.check_ticket(bad, 'download')
        with tempfile.TemporaryDirectory(prefix='2048-no-git-backup-') as directory:
            (Path(directory) / '.git').mkdir()
            with self.assertRaises(ValueError): transfer.checked_directory(directory)


if __name__ == '__main__':
    unittest.main()
