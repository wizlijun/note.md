"""Configure and inspect acceptance signatures without changing Keychain access."""
import json
import os
import subprocess

BUNDLE_ID = 'net.notemd.sumi.acceptance'


def requested_identity():
    identity = os.environ.get('SUMI_ACCEPTANCE_SIGNING_IDENTITY', '-')
    if not identity.strip() or identity != identity.strip() or '\n' in identity:
        raise ValueError('Use - or the exact signing certificate common name')
    return identity


def configure(path, identity):
    config = json.loads(path.read_text())
    if config.get('identifier') != BUNDLE_ID:
        raise ValueError('Refusing to configure a non-acceptance bundle')
    config['bundle']['macOS']['signingIdentity'] = identity
    path.write_text(json.dumps(config, indent=2) + '\n')


def signature_report(metadata, identity):
    fields = {}
    requirement = None
    for line in metadata.splitlines():
        if line.startswith(('designated =>', '# designated =>')):
            requirement = line
        elif '=' in line:
            key, value = line.split('=', 1)
            fields.setdefault(key, value)
    if fields.get('Identifier') != BUNDLE_ID or not requirement:
        raise ValueError('Missing acceptance signature identity or designated requirement')
    if identity == '-':
        if fields.get('Signature') != 'adhoc':
            raise ValueError('Expected ad-hoc acceptance signature')
    elif fields.get('Signature') == 'adhoc' or fields.get('Authority') != identity:
        raise ValueError('Actual signing certificate does not match requested common name')
    elif 'cdhash' in requirement or f'identifier "{BUNDLE_ID}"' not in requirement:
        raise ValueError('Expected a stable identifier-based designated requirement')
    return {'requestedIdentity': identity, 'authority': fields.get('Authority'),
            'teamIdentifier': fields.get('TeamIdentifier'), 'cdHash': fields.get('CDHash'),
            'designatedRequirement': requirement}


def inspect(app, identity):
    subprocess.run(['codesign', '--verify', '--deep', '--strict', str(app)], check=True)
    result = subprocess.run(['codesign', '-d', '-r-', '--verbose=4', str(app)],
                            check=True, capture_output=True, text=True)
    return signature_report(result.stdout + '\n' + result.stderr, identity)
