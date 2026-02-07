import { promisify } from 'util';
import { execFile as execFileCallback } from 'child_process';
import type { ExecFileOptionsWithStringEncoding } from 'child_process';

const execFile = promisify(execFileCallback) as (
    file: string,
    args?: ReadonlyArray<string>,
    options?: ExecFileOptionsWithStringEncoding
) => Promise<{ stdout: string; stderr: string }>;

export interface SimulatorDevice {
    name: string;
    udid: string;
    state: string;
    runtime: string;
}

interface SimctlDevice {
    name: string;
    udid: string;
    state: string;
    isAvailable: boolean;
}

interface SimctlOutput {
    devices: Record<string, SimctlDevice[]>;
}

export async function listAvailableSimulators(): Promise<SimulatorDevice[]> {
    try {
        const { stdout } = await execFile(
            'xcrun',
            ['simctl', 'list', 'devices', 'available', '-j'],
            { encoding: 'utf8' }
        );
        const parsed: SimctlOutput = JSON.parse(stdout);
        const devices: SimulatorDevice[] = [];

        for (const [runtime, deviceList] of Object.entries(parsed.devices)) {
            for (const device of deviceList) {
                if (device.isAvailable) {
                    devices.push({
                        name: device.name,
                        udid: device.udid,
                        state: device.state,
                        runtime
                    });
                }
            }
        }

        return devices.filter((d) =>
            d.runtime.includes('iOS') || d.runtime.includes('iphone')
        );
    } catch {
        return [];
    }
}
