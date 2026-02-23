export type PlatformName = 'iOS' | 'macOS' | 'tvOS' | 'watchOS';
export type PlatformDeclaration = '.iOS' | '.macOS' | '.tvOS' | '.watchOS';
export type ProductType = '.library' | '.executable';
export type TargetSPMType = '.target' | '.testTarget';

export interface DeploymentTarget {
    platform: PlatformName;
    version: string;
}

export interface ExtractObjectBodyResult {
    body: string;
    endIndex: number;
}

export type PackageRequirement = Record<string, string>;

export interface NativeTarget {
    name: string;
    productName: string;
    productType: string;
    packageProductDependencyIds: string[];
    buildConfigurationListId: string;
}

export interface BasePackageReference {
    id: string;
    name: string;
}

export interface RemoteSwiftPackageReference extends BasePackageReference {
    type: 'remote';
    url?: string;
    requirement?: PackageRequirement;
}

export interface LocalSwiftPackageReference extends BasePackageReference {
    type: 'local';
    path: string;
}

export type SwiftPackageReference = RemoteSwiftPackageReference | LocalSwiftPackageReference;

export interface SwiftPackageProductDependency {
    id: string;
    productName: string;
    packageRef: string | null;
    packageName: string | null;
}

export interface ProductDefinition {
    type: ProductType;
    name: string;
    targets: string[];
}

export interface TargetDefinition {
    name: string;
    productName: string;
    productType: string;
    spmType: TargetSPMType;
    path: string;
    isTest: boolean;
    dependencies: string[];
}

export interface TargetOutput {
    spmType: TargetSPMType;
    name: string;
    path: string;
    dependencies?: string[];
    resources?: ResourceOutput[];
    swiftSettings?: string[];
    linkerSettings?: string[];
    cSettings?: string[];
    exclude?: string[];
}

export interface BuildPackageSwiftOptions {
    packageName: string;
    swiftVersion: string;
    platforms: DeploymentTarget[];
    products: ProductDefinition[];
    dependencies: string[];
    targets: TargetOutput[];
    defaultLocalization?: string;
}

export interface BuildSettings {
    configurationName: string;
    targetId: string | null;
    swiftVersion?: string;
    swiftActiveCompilationConditions?: string[];
    otherSwiftFlags?: string[];
    gccPreprocessorDefinitions?: string[];
    headerSearchPaths?: string[];
    bundleIdentifier?: string;
    productName?: string;
}

export interface SwiftSettingsOutput {
    type: '.define' | '.unsafeFlags' | '.enableUpcomingFeature';
    value: string | string[];
    condition?: string;
}

export interface LinkerSettingsOutput {
    type: '.linkedFramework' | '.linkedLibrary';
    value: string;
}

export interface ResourceOutput {
    type: '.process' | '.copy';
    path: string;
}

export interface TargetBuildPhases {
    sourcesBuildPhaseId?: string;
    frameworksBuildPhaseId?: string;
    resourcesBuildPhaseId?: string;
}

export interface PBXBuildFile {
    id: string;
    fileRef: string;
}

export interface PBXFileReference {
    id: string;
    name: string;
    path: string;
    sourceTree?: string;
    lastKnownFileType?: string;
}

export interface TargetDependencyInfo {
    targetId: string;
    targetName: string;
}

export interface BuildTaskConfig {
    projectFile: string;
    schemeName: string;
    targetName: string;
    productName: string;
    bundleIdentifier: string;
    simulatorDevice: string;
    simulatorUdid: string;
    isPhysicalDevice?: boolean;
    deviceIdentifier?: string;
}
