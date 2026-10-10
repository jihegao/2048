#!/usr/bin/env python3
"""Transfer SQL through a short-lived URL supplied on stdin, never argv or logs.

The caller must obtain the URL from the official D1 export/import API after the
separate online freeze checks. This tool does not start an export or an import.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys
import tempfile
import urllib.parse
import urllib.request

PRODUCTION = {
    'old-production': ('8b0d70250211aa10d89e20605a1c7e5e', '4598bd98-f338-4f8b-9db7-b5b399d698f5'),
    'new-production': ('3232ebc7e9bb0199b92e3d70b07825af', 'd46a430b-4c22-469b-9af0-61b41b88e914'),
}
REHEARSAL_ACCOUNT = '3232ebc7e9bb0199b92e3d70b07825af'
REHEARSAL_DATABASES = {'ab5ed23c-b93c-47f4-9bdb-ab908acfd8a6', '3a5c6233-e45c-4491-b4f8-960ea48d51d5', '151b1d5c-d4aa-4fa5-9abd-40a6a80b4548'}


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise ValueError('Redirect refused')


def check_ticket(ticket, action):
    if not isinstance(ticket, dict) or ticket.get('action') != action:
        raise ValueError('Explicit transfer action required')
    target = ticket.get('target')
    if target in PRODUCTION:
        if (ticket.get('account_id'), ticket.get('database_id')) != PRODUCTION[target]:
            raise ValueError('Wrong production target')
        if ticket.get('confirmed_window') is not True or ticket.get('verified_frozen') is not True:
            raise ValueError('Verified frozen maintenance is required')
    elif target == 'isolated-synthetic-rehearsal':
        if ticket.get('account_id') != REHEARSAL_ACCOUNT:
            raise ValueError('Rehearsal account is unresolved')
        if ticket.get('database_id') not in REHEARSAL_DATABASES:
            raise ValueError('Rehearsal database is unresolved')
        if ticket.get('database_id') in [item[1] for item in PRODUCTION.values()]:
            raise ValueError('A production database is not a rehearsal target')
    else:
        raise ValueError('Unknown transfer target')
    parts = urllib.parse.urlsplit(ticket.get('url', ''))
    hostname = parts.hostname or ''
    if (
        parts.scheme != 'https' or parts.username or parts.password or parts.fragment
        or parts.port not in (None, 443)
        or not re.fullmatch(r'[a-z0-9-]+\.r2\.cloudflarestorage\.com', hostname)
        or not parts.path or not parts.query
    ):
        raise ValueError('Official presigned R2 URL required')
    query = urllib.parse.parse_qs(parts.query)
    if not query.get('X-Amz-Signature') or not query.get('X-Amz-Credential'):
        raise ValueError('A presigned URL is required')
    if action == 'upload' and not re.fullmatch(r'[a-f0-9]{32}', ticket.get('etag', '')):
        raise ValueError('D1 import etag is required')


def checked_directory(directory):
    directory = Path(directory)
    if not directory.is_absolute() or directory.is_symlink():
        raise ValueError('An absolute private backup directory is required')
    resolved = directory.resolve(strict=True)
    info = resolved.stat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700:
        raise ValueError('Backup directory must be owned by this user and mode 0700')
    for parent in [resolved, *resolved.parents]:
        if (parent / '.git').exists():
            raise ValueError('Backup cannot be inside a Git checkout')
    return resolved


def file_digest(path):
    sha = hashlib.sha256()
    md5 = hashlib.md5()
    total = 0
    with path.open('rb') as source:
        while chunk := source.read(1024 * 1024):
            sha.update(chunk)
            md5.update(chunk)
            total += len(chunk)
    return {'bytes': total, 'sha256': sha.hexdigest(), 'etag': md5.hexdigest()}


def transfer(ticket, action, directory, filename, opener=None):
    check_ticket(ticket, action)
    directory = checked_directory(directory)
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{0,180}\.sql', filename):
        raise ValueError('Use a simple SQL backup filename')
    destination = directory / filename
    if destination.is_symlink():
        raise ValueError('Symbolic links are not allowed')
    opener = opener or urllib.request.build_opener(NoRedirect())
    if action == 'download':
        if destination.exists():
            raise ValueError('An existing backup will never be overwritten')
        fd, temporary = tempfile.mkstemp(prefix=filename + '.', suffix='.incomplete', dir=directory)
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, 'wb') as target:
            request = urllib.request.Request(ticket['url'], headers={'User-Agent': '2048-secure-d1-transfer/1.0'})
            with opener.open(request, timeout=60) as response:
                if response.status != 200:
                    raise ValueError('Download did not succeed')
                declared = response.headers.get('Content-Length')
                total = 0
                while chunk := response.read(1024 * 1024):
                    total += len(chunk)
                    if total > 4 * 1024**3:
                        raise ValueError('Backup size limit exceeded')
                    target.write(chunk)
                if total == 0 or (declared is not None and total != int(declared)):
                    raise ValueError('Incomplete download')
            target.flush()
            os.fsync(target.fileno())
        downloaded = Path(temporary)
        hashes = file_digest(downloaded)
        if ticket.get('expected_sha256') and ticket['expected_sha256'] != hashes['sha256']:
            raise ValueError('Downloaded bytes do not match expected digest')
        # link() creates the final name exclusively, even if another process raced us.
        os.link(downloaded, destination)
        downloaded.unlink()
        parent_fd = os.open(directory, os.O_RDONLY)
        try:
            os.fsync(parent_fd)
        finally:
            os.close(parent_fd)
    else:
        info = destination.stat()
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o600:
            raise ValueError('Upload requires a private mode-0600 regular file')
        hashes = file_digest(destination)
        if hashes['bytes'] == 0 or hashes['etag'] != ticket['etag']:
            raise ValueError('Upload bytes do not match the official import etag')
        with destination.open('rb') as source:
            request = urllib.request.Request(
                ticket['url'], data=source, method='PUT',
                headers={'Content-Length': str(hashes['bytes']), 'User-Agent': '2048-secure-d1-transfer/1.0'},
            )
            with opener.open(request, timeout=60) as response:
                if response.status != 200 or response.headers.get('ETag', '').strip('"') != hashes['etag']:
                    raise ValueError('Uploaded bytes were not accepted with the expected etag')
    return {
        'action': action, 'target': ticket['target'],
        'account_id': ticket['account_id'], 'database_id': ticket['database_id'],
        'path': str(destination), 'mode': '0600', **hashes,
        'd1_export_or_ingest_started_by_this_tool': False,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['download', 'upload'])
    parser.add_argument('--directory', required=True)
    parser.add_argument('--filename', required=True)
    args = parser.parse_args()
    saved_terminal = None
    if sys.stdin.isatty():
        import termios
        saved_terminal = termios.tcgetattr(sys.stdin.fileno())
        quiet = list(saved_terminal)
        quiet[3] &= ~termios.ECHO
        termios.tcsetattr(sys.stdin.fileno(), termios.TCSANOW, quiet)
    try:
        # The orchestration layer sends this one line directly to the waiting process.
        line = sys.stdin.readline(65537)
        if len(line) > 65536 or not line.endswith('\n'):
            raise ValueError('Transfer ticket is incomplete')
        print(json.dumps(transfer(json.loads(line), args.action, args.directory, args.filename)))
    finally:
        if saved_terminal is not None:
            termios.tcsetattr(sys.stdin.fileno(), termios.TCSANOW, saved_terminal)


if __name__ == '__main__':
    try:
        main()
    except Exception:
        # Exception text can contain a signed URL, SQL or credential-bearing headers.
        print('Secure D1 transfer stopped; existing backups were preserved.', file=sys.stderr)
        sys.exit(1)
