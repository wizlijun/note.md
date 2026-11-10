#!/bin/zsh
set -euo pipefail
marker_source_dir="${0:A:h}"
marker_repo_dir="${marker_source_dir:h:h:h}"
marker_output_dir="$marker_repo_dir/tasks/sumi-macos-ime-imk"
mkdir -p "$marker_output_dir"
cd "$marker_output_dir"
mkdir -p build/SumiMarkerProbe.app/Contents/Resources build/SumiMarkerProbe.app/Contents/MacOS build/SumiMarkerProbeHost.app/Contents/MacOS evidence
clang -fobjc-arc -framework AppKit -framework Carbon -framework InputMethodKit "$marker_source_dir/ime.m" -o build/SumiMarkerProbe.app/Contents/MacOS/SumiMarkerProbe
clang -fobjc-arc -framework AppKit -framework Carbon "$marker_source_dir/host.m" -o build/SumiMarkerProbeHost.app/Contents/MacOS/SumiMarkerProbeHost
clang -fobjc-arc -framework AppKit -framework Carbon "$marker_source_dir/tisctl.m" -o build/tisctl
clang -fobjc-arc -framework AppKit "$marker_source_dir/icon.m" -o build/icon
build/icon build/SumiMarkerProbe.app/Contents/Resources/probe.tiff
python3 - <<'PY'
import plistlib
from pathlib import Path
root=Path.cwd()
common={'CFBundlePackageType':'APPL','CFBundleVersion':'1','CFBundleShortVersionString':'1.0','NSPrincipalClass':'NSApplication','SumiProbeEvidenceDirectory':str(root/'evidence')}
ime={**common,'CFBundleIdentifier':'com.notemd.inputmethod.SumiMarkerProbe','CFBundleName':'SumiMarkerProbe','CFBundleExecutable':'SumiMarkerProbe','InputMethodConnectionName':'com.notemd.inputmethod.SumiMarkerProbe_Connection','InputMethodServerControllerClass':'SumiMarkerProbeController','LSBackgroundOnly':True,'tsInputMethodCharacterRepertoireKey':['Hans','Latn'],'ComponentInputModeDict':{'tsInputModeListKey':{'com.notemd.inputmethod.SumiMarkerProbe.Hans':{'TISIntendedLanguage':'zh-Hans'}}}}
ime.update({'TISInputSourceID':'com.notemd.inputmethod.SumiMarkerProbe','CFBundleInfoDictionaryVersion':'6.0','CFBundleDevelopmentRegion':'en','LSBackgroundOnly':False,'LSUIElement':True,'InputMethodServerDelegateClass':'SumiMarkerProbeController','tsInputMethodIconFileKey':'probe.tiff'})
mode=ime['ComponentInputModeDict']['tsInputModeListKey']['com.notemd.inputmethod.SumiMarkerProbe.Hans']
mode.update({'TISInputSourceID':'com.notemd.inputmethod.SumiMarkerProbe.Hans','tsInputModeCharacterRepertoireKey':['Hans','Latn'],'tsInputModeDefaultStateKey':True,'tsInputModeIsVisibleKey':True,'tsInputModePrimaryInScriptKey':True,'tsInputModeScriptKey':'smUnicodeScript','tsInputModeMenuIconFileKey':'probe.tiff','tsInputModeAlternateMenuIconFileKey':'probe.tiff','tsInputModePaletteIconFileKey':'probe.tiff','tsInputModeKeyEquivalentModifiersKey':4608})
ime['ComponentInputModeDict']['tsVisibleInputModeOrderedArrayKey']=['com.notemd.inputmethod.SumiMarkerProbe.Hans']
host={**common,'CFBundleIdentifier':'com.notemd.SumiMarkerProbeHost','CFBundleName':'SumiMarkerProbeHost','CFBundleExecutable':'SumiMarkerProbeHost','NSHighResolutionCapable':True}
for app,info in [('SumiMarkerProbe',ime),('SumiMarkerProbeHost',host)]:
 with (root/'build'/f'{app}.app'/'Contents'/'Info.plist').open('wb') as f:plistlib.dump(info,f)
PY
codesign --force --sign - build/SumiMarkerProbe.app
codesign --force --sign - build/SumiMarkerProbeHost.app
codesign --verify --deep --strict build/SumiMarkerProbe.app
codesign --verify --deep --strict build/SumiMarkerProbeHost.app
printf 'Built isolated probes. No registration, input-source selection or application launch performed.\n'
