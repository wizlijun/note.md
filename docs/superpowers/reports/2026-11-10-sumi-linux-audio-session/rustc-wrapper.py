#!/usr/bin/env python3
import os,sys
args=sys.argv[1:]
if '--test' in args and '--crate-name' in args and args[args.index('--crate-name')+1]=='notemd_lib':
 args.extend(['-C','link-arg=-fuse-ld=lld','-C','link-arg=-Wl,--threads=1'])
os.execv(args[0],args)
