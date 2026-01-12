import { NextResponse } from 'next/server';
import { exec } from 'child_process';
import { promisify } from 'util';
import os from 'os';
import systeminformation from 'systeminformation';

const execAsync = promisify(exec);

function amdParseInt(value: any): number {
  const n = parseInt(String(value ?? '0'), 10);
  return Number.isFinite(n) ? n : 0;
}

function amdParseFloat(value: any): number {
  const n = parseFloat(String(value ?? '0'));
  return Number.isFinite(n) ? n : 0;
}

export async function GET() {
  try {
    const platform = os.platform();
    const isWindows = platform === 'win32';

    // Check NVIDIA first
    const hasNvidiaSmi = await checkNvidiaSmi(isWindows);
    if (hasNvidiaSmi) {
      const gpuStats = await getGpuStats(isWindows);
      return NextResponse.json({
        hasNvidiaSmi: true,
        hasAmdSmi: false,
        gpus: gpuStats,
      });
    }

    // Fallback to AMD ROCm (prefer amd-smi)
    const hasAmdSmi = await checkAmdSmi(isWindows);
    if (hasAmdSmi) {
      const gpuStats = await getAMDGpuStats(isWindows);
      return NextResponse.json({
        hasNvidiaSmi: false,
        hasAmdSmi: true,
        gpus: gpuStats,
      });
    }

    // CPU fallback
    const cpuStats = await getCpuStats();
    return NextResponse.json({
      hasNvidiaSmi: false,
      hasAmdSmi: false,
      gpus: [],
      cpu: cpuStats,
    });
  } catch (error) {
    console.error('Error fetching GPU stats:', error);
    return NextResponse.json(
      {
        hasNvidiaSmi: false,
        hasAmdSmi: false,
        gpus: [],
        error: `Failed to fetch GPU stats: ${error instanceof Error ? error.message : String(error)}`,
      },
      { status: 500 },
    );
  }
}

async function checkNvidiaSmi(isWindows: boolean): Promise<boolean> {
  try {
    if (isWindows) {
      await execAsync('nvidia-smi -L');
    } else {
      await execAsync('which nvidia-smi');
    }
    return true;
  } catch {
    return false;
  }
}

async function checkAmdSmi(isWindows: boolean): Promise<boolean> {
  try {
    // amd-smi is the tool that provides `static` and `metric` subcommands. [web:49]
    if (isWindows) {
      await execAsync('amd-smi version');
    } else {
      await execAsync('which amd-smi');
    }
    return true;
  } catch {
    return false;
  }
}

async function getGpuStats(isWindows: boolean) {
  const command =
    'nvidia-smi --query-gpu=index,name,driver_version,temperature.gpu,utilization.gpu,utilization.memory,memory.total,memory.free,memory.used,power.draw,power.limit,clocks.current.graphics,clocks.current.memory,fan.speed --format=csv,noheader,nounits';
  const { stdout } = await execAsync(command, {
    env: { ...process.env, CUDA_DEVICE_ORDER: 'PCI_BUS_ID' },
  });

  return stdout
    .trim()
    .split('\n')
    .map(line => {
      const [
        index,
        name,
        driverVersion,
        temperature,
        gpuUtil,
        memoryUtil,
        memoryTotal,
        memoryFree,
        memoryUsed,
        powerDraw,
        powerLimit,
        clockGraphics,
        clockMemory,
        fanSpeed,
      ] = line.split(', ').map(item => item.trim());

      return {
        index: parseInt(index),
        name,
        driverVersion,
        temperature: parseInt(temperature),
        utilization: { gpu: parseInt(gpuUtil), memory: parseInt(memoryUtil) },
        memory: { total: parseInt(memoryTotal), free: parseInt(memoryFree), used: parseInt(memoryUsed) },
        power: { draw: parseFloat(powerDraw), limit: parseFloat(powerLimit) },
        clocks: { graphics: parseInt(clockGraphics), memory: parseInt(clockMemory) },
        fan: { speed: parseInt(fanSpeed) || 0 },
      };
    });
}

async function getAMDGpuStats(isWindows: boolean) {
  // IMPORTANT:
  // - `amd-smi` supports `static` and `metric` subcommands (unlike `rocm-smi`). [web:49]
  // - Output format can differ: sometimes object with gpu_data, sometimes arrays → handle both.

  const command = 'amd-smi static --json && echo ";" && amd-smi metric --json';
  const { stdout } = await execAsync(command, {
    env: { ...process.env, CUDA_DEVICE_ORDER: 'PCI_BUS_ID' },
  });

  const parts = stdout.split(';');
  if (parts.length < 2) return [];

  let sdata: any;
  let mdata: any;
  try {
    sdata = JSON.parse(parts[0]);
    mdata = JSON.parse(parts[1]);
  } catch (error) {
    console.error('Failed to parse output of amd-smi returned json: ', error);
    return [];
  }

  // Robust: accept either { gpu_data: [...] } or [...]
  const staticGpus: any[] = Array.isArray(sdata) ? sdata : Array.isArray(sdata?.gpu_data) ? sdata.gpu_data : [];
  const metricGpus: any[] = Array.isArray(mdata) ? mdata : Array.isArray(mdata?.gpu_data) ? mdata.gpu_data : [];

  const gpus = staticGpus.map(d => {
    // GPU index comes as string often
    const i = amdParseInt(d?.gpu);

    // metrics may be missing or index might be out of range
    const gpu_data = metricGpus[i] || {};

    const mem_total = amdParseFloat(gpu_data?.mem_usage?.total_vram?.value);
    const mem_used = amdParseFloat(gpu_data?.mem_usage?.used_vram?.value);
    const mem_free = amdParseFloat(gpu_data?.mem_usage?.free_visible_vram?.value);

    const mem_utilization = mem_total > 0 ? (mem_used / mem_total) * 100 : 0;

    return {
      index: i,
      name: d?.asic?.market_name ?? 'AMD GPU',
      driverVersion: d?.driver?.version ?? 'N/A',
      temperature: amdParseInt(gpu_data?.temperature?.hotspot?.value ?? gpu_data?.temperature?.edge?.value ?? 0),
      utilization: {
        gpu: amdParseInt(gpu_data?.usage?.gfx_activity?.value ?? 0),
        memory: mem_utilization,
      },
      memory: {
        total: mem_total,
        used: mem_used,
        free: mem_free,
      },
      power: {
        draw: amdParseFloat(gpu_data?.power?.socket_power?.value ?? 0),
        limit: amdParseFloat(d?.limit?.max_power?.value ?? 0),
      },
      clocks: {
        graphics: amdParseInt(gpu_data?.clock?.gfx_0?.clk?.value ?? 0),
        memory: amdParseInt(gpu_data?.clock?.mem_0?.clk?.value ?? 0),
      },
      fan: {
        speed: amdParseFloat(gpu_data?.fan?.usage?.value ?? 0),
      },
    };
  });

  return gpus.filter(g => Number.isFinite(g.index));
}

async function getCpuStats() {
  try {
    const cpuData = await systeminformation.cpu();
    return {
      name: cpuData.manufacturer + ' ' + cpuData.brand,
      cores: cpuData.cores,
      speed: cpuData.speed,
      temperature: cpuData.temp || 0,
    };
  } catch {
    return null;
  }
}
