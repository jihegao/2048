#!/usr/bin/env python3
"""Write fixed 2048 deployment targets. No authentication or remote operations."""
import copy
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OLD = '8b0d70250211aa10d89e20605a1c7e5e'
NEW = '3232ebc7e9bb0199b92e3d70b07825af'
OLD_DB = '4598bd98-f338-4f8b-9db7-b5b399d698f5'
NEW_DB = 'd46a430b-4c22-469b-9af0-61b41b88e914'

BASE = {
    '$schema': './node_modules/wrangler/config-schema.json',
    'name': '2048-challenge-platform', 'account_id': OLD,
    'main': 'worker/index.ts', 'keep_vars': True,
    'version_metadata': {'binding': 'CF_VERSION_METADATA'},
    'compatibility_date': '2026-08-26', 'compatibility_flags': ['nodejs_compat'],
    'assets': {'directory': './dist', 'binding': 'ASSETS',
               'not_found_handling': 'single-page-application',
               'run_worker_first': ['/api/*', '/timing-design', '/timing-design/*', '/timing-design.html']},
    'workers_dev': True, 'preview_urls': True,
    'routes': [{'pattern': '2048.gaojihe.cn', 'custom_domain': True}],
    'observability': {'enabled': True, 'head_sampling_rate': 1},
    'triggers': {'crons': ['* * * * *']},
    'd1_databases': [{'binding': 'DB', 'database_name': 'challenge-platform',
                      'database_id': OLD_DB, 'migrations_dir': 'migrations'}],
    'durable_objects': {'bindings': [{'name': 'ROOMS', 'class_name': 'RoomSession'},
                                    {'name': 'LOGIN_GUARD', 'class_name': 'LoginGuard'}]},
    'migrations': [{'tag': 'v1', 'new_sqlite_classes': ['RoomSession', 'LoginGuard']}],
    'vars': {'PBKDF2_ITERATIONS': '100000', 'MIGRATION_MODE': 'normal',
             'MIGRATION_USE_D1_CONTROL': 'true', 'MIGRATION_VERIFICATION_ENABLED': 'true',
             'MIGRATION_AUDIENCE': '2048-old-production'},
}


def write(name, config):
    (ROOT / name).write_text(json.dumps(config, indent=2) + '\n')


def main():
    write('wrangler.old-preparation.jsonc', BASE)
    frozen = copy.deepcopy(BASE)
    frozen.update(main='worker/migration-freeze.ts', workers_dev=False, preview_urls=False)
    frozen['assets']['run_worker_first'] = True
    frozen['triggers']['crons'] = []
    frozen['vars']['MIGRATION_MODE'] = 'frozen'
    write('wrangler.old-frozen.jsonc', frozen)

    preparation = copy.deepcopy(frozen)
    preparation['account_id'] = NEW
    preparation['d1_databases'][0]['database_id'] = NEW_DB
    preparation['vars']['MIGRATION_AUDIENCE'] = '2048-new-production'
    preparation['routes'] = []
    preparation.pop('assets')
    # Only authenticated verification works; every business request returns 503.
    # Uses the account's existing subdomain; never creates/changes account settings.
    preparation['workers_dev'] = True
    write('wrangler.new-preparation.jsonc', preparation)

    candidate = copy.deepcopy(BASE)
    candidate['account_id'] = NEW
    candidate['main'] = 'worker/migration-candidate.ts'
    candidate['d1_databases'][0]['database_id'] = NEW_DB
    candidate['vars']['MIGRATION_AUDIENCE'] = '2048-new-production'
    candidate['vars']['MIGRATION_CANDIDATE_ENABLED'] = 'true'
    candidate['workers_dev'] = False
    candidate['preview_urls'] = False
    candidate['assets']['run_worker_first'] = True
    candidate['triggers']['crons'] = []
    candidate['routes'] = [{'pattern': 'mingcheng1024.cn', 'custom_domain': True}]
    write('wrangler.new-candidate.jsonc', candidate)

    new_frozen = copy.deepcopy(candidate)
    new_frozen['main'] = 'worker/migration-freeze.ts'
    new_frozen['vars']['MIGRATION_MODE'] = 'frozen'
    new_frozen['vars'].pop('MIGRATION_CANDIDATE_ENABLED')
    write('wrangler.new-frozen.jsonc', new_frozen)

    production = copy.deepcopy(BASE)
    production['account_id'] = NEW
    production['d1_databases'][0]['database_id'] = NEW_DB
    production['vars']['MIGRATION_AUDIENCE'] = '2048-new-production'
    production['vars']['MIGRATION_VERIFICATION_ENABLED'] = 'false'
    production['vars']['MIGRATION_CANDIDATE_ENABLED'] = 'false'
    production['workers_dev'] = False
    production['preview_urls'] = False
    production['routes'] = [{'pattern': 'mingcheng1024.cn', 'custom_domain': True}]
    write('wrangler.new-production.jsonc', production)

    staging = copy.deepcopy(BASE)
    staging['name'] = '2048-challenge-platform-staging'
    staging['d1_databases'][0].update(database_name='challenge-platform-staging', database_id='3a9d4b6b-5fca-4fe7-96d5-c252c2ce7a38')
    staging['routes'] = [{'pattern': 'preview.2048.gaojihe.cn', 'custom_domain': True}]
    staging['vars'].update(MIGRATION_USE_D1_CONTROL='false', MIGRATION_VERIFICATION_ENABLED='false', MIGRATION_AUDIENCE='2048-old-staging')
    write('wrangler.staging.jsonc', staging)
    print('Wrote seven fixed deployment targets; no remote changes')


if __name__ == '__main__':
    main()
