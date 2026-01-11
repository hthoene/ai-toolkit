import { NextResponse } from 'next/server';
import { exec } from 'child_process';
import { promisify } from 'util';
import os from 'os';
import systeminformation from 'systeminformation';

const execAsync = promisify(exec);

function amdParseInt(value: any): number {
  return parseInt(value || 0);
}

function amdParseFloat(value: any): number {
  return parseFloat(value || 0);
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

    // Fallback to AMD ROCm
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
    await execAsync(isWindows ? 'amd-smi --help' : 'which rocm-smi || which amd-smi');
    return true;
  } catch {
    return false;
  }
}

async function getGpuStats(isWindows: boolean) {
  const command = 'nvidia-smi --query-gpu=index,name,driver_version,temperature.gpu,utilization.gpu,utilization.memory,memory.total,memory.free,memory.used,power.draw,power.limit,clocks.current.graphics,clocks.current.memory,fan.speed --format=csv,noheader,nounits';
  const { stdout } = await execAsync(command, {
    env: { ...process.env, CUDA_DEVICE_ORDER: 'PCI_BUS_ID' },
  });

  return stdout.trim().split('\n').map(line => {
    const [
      index, name, driverVersion, temperature, gpuUtil, memoryUtil,
      memoryTotal, memoryFree, memoryUsed, powerDraw, powerLimit,
      clockGraphics, clockMemory, fanSpeed,
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
  const command = 'rocm-smi static --json && echo ";" && rocm-smi metric --json';
  const { stdout } = await execAsync(command, {
    env: { ...process.env },
  });
  
  const data = stdout.trim().split(';');
  if (data.length < 2) return [];

  let sdata: any = {}, mdata: any = {};
  try {
    sdata = JSON.parse(data[0]);
    mdata = JSON.parse(data[1]);
  } catch (error) {
    console.error('Failed to parse rocm-smi JSON:', error);
    return [];
  }

  // ROCm
  const staticGpus = Array.isArray(sdata.gpu_data) ? sdata.gpu_data : (Array.isArray(sdata) ? sdata : []);
  const metricGpus = Array.isArray(mdata.gpu_data) ? mdata.gpu_data : (Array.isArray(mdata) ? mdata : []);

  return staticGpus.map((d: any, index: number) => {
    const i = amdParseInt(d.gpu || index);
    const gpu_data = metricGpus[i] || {};
    
    const mem_total = amdParseFloat(gpu_data.mem_usage?.total_vram?.value || 0);
    const mem_used = amdParseFloat(gpu_data.mem_usage?.used_vram?.value || 0);
    const mem_free = amdParseFloat(gpu_data.mem_usage?.free_visible_vram?.value || 0);
    const mem_util = mem_total > 0 ? (mem_used / mem_total * 100) : 0;

    return {
      index: i,
      name: d.asic?.market_name || 'AMD GPU',
      driverVersion: d.driver?.version || 'N/A',
      temperature: amdParseInt(gpu_data.temperature?.hotspot?.value || 0),
      utilization: {
        gpu: amdParseInt(gpu_data.usage?.gfx_activity?.value || 0),
        memory: mem_util,
      },
      memory: { total: mem_total, used: mem_used, free: mem_free },
      power: {
        draw: amdParseFloat(gpu_data.power?.socket_power?.value || 0),
        limit: amdParseFloat(d.limit?.max_power?.value || 0),
      },
      clocks: {
        graphics: amdParseInt(gpu_data.clock?.gfx_0?.clk?.value || 0),
        memory: amdParseInt(gpu_data.clock?.mem_0?.clk?.value || 0),
      },
      fan: { speed: amdParseFloat(gpu_data.fan?.usage?.value || 0) },
    };
  }).filter((g: any) => g.index !== undefined);
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
