import { buildCommandLine, buildInstallCommandLine, launchAppCommandLine } from './buildTasks';
import type { BuildTaskConfig } from '../types/interfaces';

const config: BuildTaskConfig = {
    projectFile: 'MyApp.xcodeproj',
    schemeName: 'MyApp',
    targetName: 'MyApp',
    productName: 'MyApp',
    bundleIdentifier: 'com.example.MyApp',
    simulatorDevice: 'iPhone 15',
};

describe('buildCommandLine', () => {
    it('generates xcodebuild command with correct project and scheme', () => {
        const cmd = buildCommandLine(config);
        expect(cmd).toContain('-project "MyApp.xcodeproj"');
        expect(cmd).toContain('-scheme "MyApp"');
    });

    it('includes iphonesimulator SDK', () => {
        const cmd = buildCommandLine(config);
        expect(cmd).toContain('-sdk iphonesimulator');
    });

    it('includes DerivedData path based on scheme', () => {
        const cmd = buildCommandLine(config);
        expect(cmd).toContain('DerivedData/MyApp');
    });

    it('includes build action', () => {
        const cmd = buildCommandLine(config);
        expect(cmd).toContain('build 2>&1');
    });

    it('uses pipefail', () => {
        const cmd = buildCommandLine(config);
        expect(cmd).toContain('set -eo pipefail');
    });

    it('includes strict concurrency when set', () => {
        const configWithConcurrency: BuildTaskConfig = {
            ...config,
            strictConcurrency: 'complete',
        };
        const cmd = buildCommandLine(configWithConcurrency);
        expect(cmd).toContain('SWIFT_STRICT_CONCURRENCY=complete');
    });

    it('omits strict concurrency when not set', () => {
        const cmd = buildCommandLine(config);
        expect(cmd).not.toContain('SWIFT_STRICT_CONCURRENCY');
    });
});

describe('buildInstallCommandLine', () => {
    it('includes build, boot, terminate, install, and open steps', () => {
        const cmd = buildInstallCommandLine(config);
        expect(cmd).toContain('build 2>&1');
        expect(cmd).toContain('xcrun simctl boot');
        expect(cmd).toContain('xcrun simctl terminate');
        expect(cmd).toContain('xcrun simctl install');
        expect(cmd).toContain('open -a Simulator');
    });

    it('references correct simulator device', () => {
        const cmd = buildInstallCommandLine(config);
        expect(cmd).toContain('"iPhone 15"');
    });

    it('references correct bundle identifier for terminate', () => {
        const cmd = buildInstallCommandLine(config);
        expect(cmd).toContain('"com.example.MyApp"');
    });

    it('references correct .app path', () => {
        const cmd = buildInstallCommandLine(config);
        expect(cmd).toContain('Debug-iphonesimulator/MyApp.app');
    });

    it('includes strict concurrency when set', () => {
        const configWithConcurrency: BuildTaskConfig = {
            ...config,
            strictConcurrency: 'targeted',
        };
        const cmd = buildInstallCommandLine(configWithConcurrency);
        expect(cmd).toContain('SWIFT_STRICT_CONCURRENCY=targeted');
    });
});

describe('launchAppCommandLine', () => {
    it('generates simctl launch command', () => {
        const cmd = launchAppCommandLine(config);
        expect(cmd).toBe(
            'xcrun simctl launch --console-pty --wait-for-debugger booted "com.example.MyApp"'
        );
    });
});
