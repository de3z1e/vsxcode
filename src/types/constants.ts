import type { PlatformName, PlatformDeclaration, DeploymentTarget } from './interfaces';

export const PLATFORM_KEYS: Record<string, PlatformName> = {
    IPHONEOS_DEPLOYMENT_TARGET: 'iOS',
    MACOSX_DEPLOYMENT_TARGET: 'macOS',
    TVOS_DEPLOYMENT_TARGET: 'tvOS',
    WATCHOS_DEPLOYMENT_TARGET: 'watchOS'
};

export const PLATFORM_DECLARATIONS: Record<PlatformName, PlatformDeclaration> = {
    iOS: '.iOS',
    macOS: '.macOS',
    tvOS: '.tvOS',
    watchOS: '.watchOS'
};

export const DEFAULT_SWIFT_VERSION = '6.2';
export const DEFAULT_PLATFORM: DeploymentTarget = { platform: 'iOS', version: '26.0' };
export const INDENT = '    ';

export const IMPLICIT_FRAMEWORKS = new Set([
    'Foundation',
    'Swift',
    'SwiftUI',
    'UIKit',
    'AppKit',
    'Combine',
    'CoreFoundation',
    'Darwin',
    'ObjectiveC',
    'Dispatch',
    'os'
]);

export const PROCESSABLE_RESOURCE_EXTENSIONS = new Set([
    '.xcassets',
    '.storyboard',
    '.xib',
    '.strings',
    '.stringsdict',
    '.intentdefinition',
    '.xcmappingmodel',
    '.xcdatamodeld',
    '.lproj'
]);

// Extensions that SPM treats as source files (no explicit handling needed)
export const SPM_SOURCE_EXTENSIONS = new Set([
    '.swift', '.c', '.m', '.mm', '.cpp', '.cc', '.cxx',
    '.S', '.s', '.h', '.hpp', '.hh', '.def'
]);

// Files that should be auto-excluded from SPM targets (Xcode-specific)
export const SPM_AUTO_EXCLUDE_FILENAMES = new Set([
    'Info.plist'
]);

// Extensions that should be auto-excluded from SPM targets
export const SPM_AUTO_EXCLUDE_EXTENSIONS = new Set([
    '.entitlements', '.pch'
]);

// Directory extensions that are bundle-like and should be treated as SPM resources
export const SPM_RESOURCE_DIR_EXTENSIONS = new Set([
    '.xcdatamodeld', '.xcdatamodel', '.xcmappingmodel',
    '.xcassets', '.storyboard', '.xib',
    '.lproj', '.mlmodel', '.mlpackage', '.bundle'
]);

export const SWIFT_VERSION_MAP: Record<string, string> = {
    '6.0': '.v6',
    '6': '.v6',
    '5.10': '.v5',
    '5.9': '.v5',
    '5': '.v5'
};

// Overlap data moved to src/types/ruleMapping.ts (OVERLAP_PAIRS)
