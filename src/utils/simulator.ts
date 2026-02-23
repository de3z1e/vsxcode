import { promisify } from 'util';
import { execFile as execFileCallback } from 'child_process';
import type { ExecFileOptionsWithStringEncoding } from 'child_process';
import { promises as fsp } from 'fs';
import * as os from 'os';
import * as path from 'path';

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

export interface PhysicalDevice {
    name: string;
    udid: string;
    deviceIdentifier: string;
    osVersion: string;
    connectionType: string;
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

export async function listPhysicalDevices(): Promise<PhysicalDevice[]> {
    const tmpFile = path.join(os.tmpdir(), `sph-devices-${Date.now()}.json`);
    try {
        await execFile(
            'xcrun',
            ['devicectl', 'list', 'devices', '--json-output', tmpFile],
            { encoding: 'utf8' }
        );
        const content = await fsp.readFile(tmpFile, 'utf8');
        const parsed = JSON.parse(content);
        const devices: PhysicalDevice[] = [];

        for (const device of parsed.result?.devices || []) {
            const platform = device.hardwareProperties?.platform;
            const pairingState = device.connectionProperties?.pairingState;
            if (platform === 'iOS' && pairingState === 'paired') {
                devices.push({
                    name: device.deviceProperties?.name || 'Unknown Device',
                    udid: device.hardwareProperties?.udid || device.identifier || '',
                    deviceIdentifier: device.identifier || '',
                    osVersion: device.deviceProperties?.osVersionNumber || '',
                    connectionType: device.connectionProperties?.transportType || 'unknown',
                });
            }
        }

        return devices;
    } catch {
        return [];
    } finally {
        try { await fsp.unlink(tmpFile); } catch { /* ignore cleanup errors */ }
    }
}
