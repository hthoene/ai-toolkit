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
  const command = `rocm-smi --showname --showhw --showmeminfo vram --showpower --showtemp --showclocks --showfan --json`;
  const { stdout } = await execAsync(command);
  
  let data: any;
  try {
    data = JSON.parse(stdout);
  } catch (error) {
    console.error('Failed to parse rocm-smi JSON:', error);
    return [];
  }

  const gpus = Array.isArray(data) ? data : (data.gpu_devices || []);
  
  return gpus.map((gpu: any, index: number) => ({
    index,
    name: gpu.product_name || 'AMD GPU',
    driverVersion: gpu.driver_version || 'N/A',
    temperature: parseInt(gpu.temperature_edge || gpu.temperature_gpu || 0),
    utilization: {
      gpu: parseInt(gpu.gpu_util || 0),
      memory: parseInt(gpu.vram_util || 0),
    },
    memory: {
      total: parseFloat(gpu.vram_total || 0),
      used: parseFloat(gpu.vram_used || 0),
      free: parseFloat(gpu.vram_free || 0),
    },
    power: {
      draw: parseFloat(gpu.power_current || 0),
      limit: parseFloat(gpu.power_limit || 0),
    },
    clocks: {
      graphics: parseInt(gpu.gfx_clock || 0),
      memory: parseInt(gpu.mem_clock || 0),
    },
    fan: {
      speed: parseFloat(gpu.fan_speed || 0),
    },
  })).filter((g: any) => g.index !== undefined);
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
