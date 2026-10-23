import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { probeRTX3090 } from './advisor-rtx3090-runtime.mjs';

const execute = promisify(execFile);

// These diagnostics are fixed, read-only programs. No caller data, credentials, or
// shell interpolation can enter either command.
const HALO_PROBE = `import json,pathlib,subprocess
def read(p):
 try: return pathlib.Path(p).read_text().strip()
 except OSError: return None
def active(name,user=False):
 p=subprocess.run(['systemctl']+(['--user'] if user else [])+['is-active',name],capture_output=True,text=True,timeout=2)
 return p.stdout.strip() or 'unknown'
gpus=[]
for p in pathlib.Path('/sys/class/drm').glob('card[0-9]/device'):
 device=read(p/'device')
 if read(p/'vendor')!='0x1002' or device!='0x1586': continue
 gpus.append(dict(device=device,worker='halo',vramUsedBytes=read(p/'mem_info_vram_used'),vramTotalBytes=read(p/'mem_info_vram_total'),gttUsedBytes=read(p/'mem_info_gtt_used'),busyPercent=read(p/'gpu_busy_percent')))
memory={}
for line in (read('/proc/meminfo') or '').splitlines():
 name,value=line.split(':',1)
 if name in ['MemTotal','MemAvailable','SwapTotal','SwapFree']: memory[name+'KiB']=int(value.strip().split()[0])
print(json.dumps(dict(gpus=gpus,memory=memory,oculink=dict(applicable=False,reason='internal-pcie'),services={name:active(name) for name in ['amd-superqwen.service','amd-flash-hybrid.service','amd-qwen-coder.service']},gaia={name:active(name,True) for name in ['gaia-web.service','gaia-desktop.service','lemonade-media.service']})))`;

const SERVER_KEY = '/SETUP_REQUIRED/path-29';
const SERVER_PINS = '/SETUP_REQUIRED/path-30';
const SERVER_PROBE = "$ErrorActionPreference='Stop';$gpu=@(Get-PnpDevice -Class Display -PresentOnly|Where-Object {$_.FriendlyName -match 'R9700'}|ForEach-Object {$p=$_;$bus=(Get-PnpDeviceProperty -InstanceId $p.InstanceId -KeyName 'DEVPKEY_Device_BusNumber' -ErrorAction SilentlyContinue).Data;$address=(Get-PnpDeviceProperty -InstanceId $p.InstanceId -KeyName 'DEVPKEY_Device_Address' -ErrorAction SilentlyContinue).Data;$device=if($null -ne $bus -and $null -ne $address){$slot=(([uint32]$address -shr 16) -band 0xFFFF);$function=([uint32]$address -band 0xFFFF);'{0:X2}:{1:X2}.{2:X1}' -f [int]$bus,$slot,$function}else{$null};$worker=if($device -eq '03:00.0'){'r9700'}elseif($device -eq '07:00.0'){'r9700b'}else{$null};[pscustomobject]@{name=[string]$p.FriendlyName;status=[string]$p.Status;problem=[string]$p.Problem;device=$device;worker=$worker;vramUsedBytes=$null;vramTotalBytes=$null;gttUsedBytes=$null;busyPercent=$null}});$os=Get-CimInstance Win32_OperatingSystem;$tasks=@('SETUP_REQUIRED_WORKER_A_TASK','SETUP_REQUIRED_WORKER_B_TASK')|ForEach-Object {$t=Get-ScheduledTask -TaskName $_ -ErrorAction SilentlyContinue;[pscustomobject]@{name=$_;state=if($t){[string]$t.State}else{'missing'}}};[pscustomobject]@{gpus=$gpu;memory=[pscustomobject]@{TotalVisibleMemorySizeKiB=$os.TotalVisibleMemorySize;FreePhysicalMemoryKiB=$os.FreePhysicalMemory};services=$tasks}|ConvertTo-Json -Depth 5 -Compress";

const unavailable = (host) => ({ available: false, reason: `${host.toUpperCase()}_HARDWARE_PROBE_UNAVAILABLE` });
const checked = () => new Date().toISOString();

async function probeHalo(executeImpl) {
  const remote = `python3 -c '${HALO_PROBE.replaceAll("'", "'\\''")}'`;
  const { stdout } = await executeImpl('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=3', 'SETUP_REQUIRED_SSH_HOST', remote], {
    timeout: 6000, maxBuffer: 16000, windowsHide: true,
  });
  const value = JSON.parse(stdout);
  if (!Array.isArray(value.gpus) || !value.services || !value.gaia || !value.memory) throw new Error('INVALID_HALO_PROBE');
  return { available: true, ...value, checkedAt: checked() };
}

async function probeMain(executeImpl) {
  const encoded=Buffer.from(SERVER_PROBE,'utf16le').toString('base64');
  const { stdout } = await executeImpl('/SETUP_REQUIRED/path-31', ['-F','NUL','-i',SERVER_KEY,'-o','IdentitiesOnly=yes','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o',`UserKnownHostsFile=${SERVER_PINS}`,'-o','KexAlgorithms=curve25519-sha256','-o','ConnectTimeout=10','LOCAL_USER_OR_HOST@SETUP_REQUIRED_ADDRESS_15',`powershell -NoProfile -NonInteractive -EncodedCommand ${encoded}`], {
    timeout: 15000, maxBuffer: 16000, windowsHide: true,
  });
  const value = JSON.parse(stdout);
  if (!Array.isArray(value.gpus) || !value.memory || !Array.isArray(value.services) || value.gpus.some(gpu => typeof gpu?.device!=='string' || !['r9700','r9700b'].includes(gpu.worker) || !['03:00.0','07:00.0'].includes(gpu.device))) throw new Error('INVALID_MAIN_PROBE');
  const gpuAvailable=value.gpus.length===2&&new Set(value.gpus.map(gpu=>gpu.worker)).size===2&&value.gpus.every(gpu=>gpu.status==='OK');
  return { available: true, gpuAvailable, ...value, checkedAt: checked() };
}

export async function hardwareStatus({ executeImpl = execute,rtx3090Probe=()=>probeRTX3090({executeImpl}) } = {}) {
  const [mainResult, haloResult,rtxResult] = await Promise.allSettled([probeMain(executeImpl), probeHalo(executeImpl),rtx3090Probe()]);
  const main = mainResult.status === 'fulfilled' ? mainResult.value : unavailable('main');
  const halo = haloResult.status === 'fulfilled' ? haloResult.value : unavailable('halo');
  const rtx3090=rtxResult.status==='fulfilled'?{available:true,gpu:rtxResult.value,checkedAt:checked()}:unavailable('rtx3090');
  const available = main.available || halo.available || rtx3090.available;
  const result = {
    available,
    // Legacy consumers continue to receive Halo's original data shape.
    gpus: [...(halo.gpus ?? []).map(gpu => ({ ...gpu, host: 'halo' })), ...(main.gpus ?? []).map(gpu => ({ ...gpu, host: 'main' })),...(rtx3090.available?[{...rtx3090.gpu,host:'main',vramTotalBytes:rtx3090.gpu.totalMiB*1048576,vramUsedBytes:(rtx3090.gpu.totalMiB-rtx3090.gpu.freeMiB)*1048576}]:[])],
    memory: halo.memory ?? null,
    services: { ...(halo.services ?? {}), ...(main.services ?? {}) },
    gaia: halo.gaia ?? null,
    oculink: { applicable: false, reason: 'internal-pcie' },
    checkedAt: checked(),
    hosts: { main, halo,rtx3090 },
  };
  if (!available) result.reason = 'HARDWARE_PROBE_UNAVAILABLE';
  return result;
}
