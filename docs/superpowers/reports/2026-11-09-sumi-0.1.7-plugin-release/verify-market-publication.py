#!/usr/bin/env python3
"""Independent post-publication index audit; no remote mutations or package downloads."""
from pathlib import Path
import argparse
import concurrent.futures,datetime,hashlib,importlib.util,json
HERE=Path(__file__).resolve().parent
parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--source',required=True)
args=parser.parse_args()
s=importlib.util.spec_from_file_location('publisher',HERE/'publish-plugin.py');p=importlib.util.module_from_spec(s);s.loader.exec_module(p);p.load_frozen(args.source)
p.require(p.digest(HERE/'publish-plugin.py')=='ac09adc738897c61950e6a09773a98952166a86e0ed2654578e72912489363e9','Audited publisher changed')
entries=p.check_packages()
pre=json.loads((HERE/'plugins-index-readonly.json').read_text())
before=json.loads((HERE/'plugins-index-before.json').read_text())
candidate=json.loads((HERE/'plugins-index-candidate.json').read_text())
expected=p.merge_entries(before,entries)
p.require(candidate==expected,'Published candidate differs from history-preserving merge')
p.require(before==pre,'Registry changed since original frozen preflight')
p.require(len(candidate['plugins'])==len(before['plugins'])+1,'Expected exactly one newly appended Sumi version')
receipt=json.loads((HERE/'plugins-index-verification.json').read_text())
p.require(receipt['ok'] and receipt['publicNormalFreshAndKvEqual'] and receipt['historicalEntriesUnchanged'],'Publisher final receipt incomplete')
compatibility=json.loads((HERE/'plugin-pending-host-compatibility.json').read_text())
gate=json.loads((HERE/'plugin-pending-host-gate.json').read_text())
p.require(receipt.get('compatibleHostPublic') is False and receipt.get('publishedBeforeCompatibleHost') is True, 'Host publication state misreported')
p.require(gate.get('ok') is True and gate.get('compatibilityReportSha256')==p.digest(HERE/'plugin-pending-host-compatibility.json') and compatibility.get('ok') is True, 'Pending-host evidence mismatch')
proof_spec=importlib.util.spec_from_file_location('readback_proof',HERE/'verify-preserved-package-readbacks.py')
proof_module=importlib.util.module_from_spec(proof_spec);proof_spec.loader.exec_module(proof_module)
objects=proof_module.verify(p)
def public(mode):
 path=HERE/f'plugins-market-independent-{mode}.json'
 p.require(p.fetch(p.INDEX if mode=='normal' else p.fresh(p.INDEX),path)==200,'Public index read failed')
 return mode,json.loads(path.read_bytes())
with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
 public_indices=dict(pool.map(public,['normal','fresh']))
kv=p.read_kv('plugins-market-independent-kv.json')
p.require(kv==candidate==public_indices['normal']==public_indices['fresh'],'KV/normal/fresh index not identical to exact candidate')
p.require(candidate['plugins'][:len(before['plugins'])]==before['plugins'],'Historical entries changed')
report={'ok':True,'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'readOnly':True,'sourceCommit':p.FROZEN['sourceCommit'],'publisherSha256':p.digest(HERE/'publish-plugin.py'),'beforeCount':len(before['plugins']),'afterCount':len(candidate['plugins']),'onlyAdded':entries,'historicalEntriesUnchanged':True,'kvNormalFreshExactlyEqualCandidate':True,'newVersionsMatchFrozenPackages':True,'compatibleMinimumHost':'>=6.1109.2','compatibleHostPublic':False,'publishedBeforeCompatibleHost':True,'compatibilityReportSha256':p.digest(HERE/'plugin-pending-host-compatibility.json'),'publisherFullPackageEvidence':'plugins-public-packages.json','preservedFullObjects':objects,'preservedFullPackageSignaturesAndZipInventoriesRecheckedLocally':True,'postPublicationNetworkPackageDownloadsPerformed':False,'boundary':'Original publisher performed complete normal/fresh package and signature readback before index publication. This independent post-publication audit rechecks all four preserved objects against frozen bytes, hashes, signatures and ZIP inventory, then reads authoritative KV and normal/fresh public indices. No independent pre-publication readback is claimed.'}
(HERE/'plugins-market-independent-verification.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
print(json.dumps({'ok':True,'onlyAdded':[(x['id'],x['version']) for x in entries],'before':report['beforeCount'],'after':report['afterCount'],'kvNormalFreshEqual':True,'historicalEntriesUnchanged':True}))
