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

        return devices
            .filter((d) => d.runtime.includes('iOS') || d.runtime.includes('iphone'))
            .sort((a, b) => {
                const aBooted = a.state === 'Booted' ? 0 : 1;
                const bBooted = b.state === 'Booted' ? 0 : 1;
                if (aBooted !== bBooted) { return aBooted - bBooted; }
                const parseVersion = (runtime: string): number[] => {
                    const match = runtime.match(/(\d+)-(\d+)(?:-(\d+))?$/);
                    return match ? [Number(match[1]), Number(match[2]), Number(match[3] || 0)] : [0, 0, 0];
                };
                const aVer = parseVersion(a.runtime);
                const bVer = parseVersion(b.runtime);
                for (let i = 0; i < 3; i++) {
                    if (bVer[i] !== aVer[i]) { return bVer[i] - aVer[i]; }
                }
                return 0;
            });
    } catch {
        return [];
    }
}

export async function devicectlInstall(deviceId: string, appPath: string): Promise<void> {
    await execFile(
        'xcrun',
        ['devicectl', 'device', 'install', 'app', '--device', deviceId, appPath],
        { encoding: 'utf8' }
    );
}

export async function devicectlTerminate(deviceId: string, pid: number): Promise<void> {
    try {
        await execFile(
            'xcrun',
            ['devicectl', 'device', 'process', 'terminate', '--device', deviceId, '--pid', String(pid)],
            { encoding: 'utf8' }
        );
    } catch {
        // Best-effort: app may already have exited
    }
}

export async function checkDeviceReady(deviceId: string): Promise<{ ready: boolean; message?: string }> {
    try {
        const { stdout, stderr } = await execFile(
            'xcrun',
            ['lldb', '--batch', '-o', 'platform select remote-ios', '-o', `device select ${deviceId}`, '-o', 'quit'],
            { encoding: 'utf8' }
        );
        const output = stdout + stderr;
        if (output.includes('needs to be unlocked')) {
            return { ready: false, message: 'Device needs to be unlocked.' };
        }
        return { ready: true };
    } catch (error) {
        const message = String((error as { stderr?: string }).stderr || error);
        if (message.includes('needs to be unlocked')) {
            return { ready: false, message: 'Device needs to be unlocked.' };
        }
        // Other errors — let the debug session handle them
        return { ready: true };
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
                    connectionType: device.connectionProperties?.transportType || 'Unknown',
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
