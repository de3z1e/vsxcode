// Realistic pbxproj section snippets for unit tests

export const BUILD_CONFIGURATION_SECTION = `
/* Begin XCBuildConfiguration section */
		ABC12345678901234567890A /* Debug */ = {
			isa = XCBuildConfiguration;
			buildSettings = {
				SWIFT_VERSION = 5.9;
				SWIFT_ACTIVE_COMPILATION_CONDITIONS = (
					"$(inherited)",
					DEBUG,
					BETA_FEATURE,
				);
				OTHER_SWIFT_FLAGS = "$(inherited) -Xfrontend -warn-concurrency";
				GCC_PREPROCESSOR_DEFINITIONS = (
					"$(inherited)",
					"DEBUG=1",
					"APP_VERSION=42",
				);
				HEADER_SEARCH_PATHS = (
					"$(inherited)",
					"$(SRCROOT)/Headers",
				);
				PRODUCT_BUNDLE_IDENTIFIER = com.example.MyApp;
				PRODUCT_NAME = MyApp;
				SWIFT_STRICT_CONCURRENCY = complete;
			};
			name = Debug;
		};
		ABC12345678901234567890B /* Release */ = {
			isa = XCBuildConfiguration;
			buildSettings = {
				SWIFT_VERSION = 5.9;
				SWIFT_ACTIVE_COMPILATION_CONDITIONS = RELEASE_FLAG;
				PRODUCT_BUNDLE_IDENTIFIER = com.example.MyApp;
				PRODUCT_NAME = MyApp;
			};
			name = Release;
		};
		DEF12345678901234567890A /* Debug */ = {
			isa = XCBuildConfiguration;
			buildSettings = {
				SWIFT_VERSION = 5.9;
				SWIFT_ACTIVE_COMPILATION_CONDITIONS = "$(inherited)";
				PRODUCT_BUNDLE_IDENTIFIER = com.example.MyAppTests;
				PRODUCT_NAME = MyAppTests;
			};
			name = Debug;
		};
		DEF12345678901234567890B /* Release */ = {
			isa = XCBuildConfiguration;
			buildSettings = {
				SWIFT_VERSION = 5.9;
				PRODUCT_BUNDLE_IDENTIFIER = com.example.MyAppTests;
				PRODUCT_NAME = MyAppTests;
			};
			name = Release;
		};
/* End XCBuildConfiguration section */
`;

export const CONFIGURATION_LIST_SECTION = `
/* Begin XCConfigurationList section */
		CCCCCCCCCCCCCCCCCCCCCCCA /* Build configuration list for PBXProject "MyApp" */ = {
			isa = XCConfigurationList;
			buildConfigurations = (
				ABC12345678901234567890A /* Debug */,
				ABC12345678901234567890B /* Release */,
			);
			defaultConfigurationIsVisible = 0;
			defaultConfigurationName = Release;
		};
		CCCCCCCCCCCCCCCCCCCCCCCD /* Build configuration list for PBXNativeTarget "MyAppTests" */ = {
			isa = XCConfigurationList;
			buildConfigurations = (
				DEF12345678901234567890A /* Debug */,
				DEF12345678901234567890B /* Release */,
			);
			defaultConfigurationIsVisible = 0;
			defaultConfigurationName = Release;
		};
/* End XCConfigurationList section */
`;

export const PROJECT_SECTION = `
/* Begin PBXProject section */
		AAAAAAAAAAAAAAAAAAAAAAAA /* Project object */ = {
			isa = PBXProject;
			buildConfigurationList = CCCCCCCCCCCCCCCCCCCCCCCA /* Build configuration list for PBXProject "MyApp" */;
			compatibilityVersion = "Xcode 14.0";
			developmentRegion = en;
			mainGroup = BBBBBBBBBBBBBBBBBBBBBBBB;
			packageReferences = (
				EEEEEEEEEEEEEEEEEEEEEEEA /* XCRemoteSwiftPackageReference "Alamofire" */,
			);
			productRefGroup = DDDDDDDDDDDDDDDDDDDDDDDD /* Products */;
			projectDirPath = "";
			projectRoot = "";
			targets = (
			);
		};
/* End PBXProject section */
`;

export const NATIVE_TARGET_SECTION = `
/* Begin PBXNativeTarget section */
		111111111111111111111111 /* MyApp */ = {
			isa = PBXNativeTarget;
			buildConfigurationList = CCCCCCCCCCCCCCCCCCCCCCCA /* Build configuration list for PBXNativeTarget "MyApp" */;
			buildPhases = (
				AAAA11111111111111111111 /* Sources */,
				BBBB11111111111111111111 /* Frameworks */,
				CCCC11111111111111111111 /* Resources */,
			);
			buildRules = (
			);
			dependencies = (
				DDDD11111111111111111111 /* PBXTargetDependency */,
			);
			name = MyApp;
			packageProductDependencies = (
				FFFF11111111111111111111 /* Alamofire */,
			);
			productName = MyApp;
			productReference = GGGG11111111111111111111 /* MyApp.app */;
			productType = "com.apple.product-type.application";
		};
		222222222222222222222222 /* MyAppTests */ = {
			isa = PBXNativeTarget;
			buildConfigurationList = CCCCCCCCCCCCCCCCCCCCCCCD /* Build configuration list for PBXNativeTarget "MyAppTests" */;
			buildPhases = (
				AAAA22222222222222222222 /* Sources */,
				BBBB22222222222222222222 /* Frameworks */,
			);
			buildRules = (
			);
			dependencies = (
			);
			name = MyAppTests;
			productName = MyAppTests;
			productReference = GGGG22222222222222222222 /* MyAppTests.xctest */;
			productType = "com.apple.product-type.bundle.unit-test";
		};
/* End PBXNativeTarget section */
`;

export const TARGET_DEPENDENCY_SECTION = `
/* Begin PBXTargetDependency section */
		DDDD11111111111111111111 /* PBXTargetDependency */ = {
			isa = PBXTargetDependency;
			target = 333333333333333333333333 /* CoreLib */;
			targetProxy = EEEE11111111111111111111 /* PBXContainerItemProxy */;
		};
/* End PBXTargetDependency section */
`;

export const REMOTE_PACKAGE_SECTION = `
/* Begin XCRemoteSwiftPackageReference section */
		EEEEEEEEEEEEEEEEEEEEEEEA /* XCRemoteSwiftPackageReference "Alamofire" */ = {
			isa = XCRemoteSwiftPackageReference;
			repositoryURL = "https://github.com/Alamofire/Alamofire.git";
			requirement = {
				kind = upToNextMajorVersion;
				minimumVersion = 5.8.0;
			};
		};
		EEEEEEEEEEEEEEEEEEEEEEE2 /* XCRemoteSwiftPackageReference "SnapKit" */ = {
			isa = XCRemoteSwiftPackageReference;
			repositoryURL = "https://github.com/SnapKit/SnapKit.git";
			requirement = {
				kind = exactVersion;
				version = 5.6.0;
			};
		};
		EEEEEEEEEEEEEEEEEEEEEEE3 /* XCRemoteSwiftPackageReference "Moya" */ = {
			isa = XCRemoteSwiftPackageReference;
			repositoryURL = "https://github.com/Moya/Moya.git";
			requirement = {
				kind = branch;
				branch = main;
			};
		};
/* End XCRemoteSwiftPackageReference section */
`;

export const LOCAL_PACKAGE_SECTION = `
/* Begin XCLocalSwiftPackageReference section */
		AABB11111111111111111101 /* XCLocalSwiftPackageReference "CoreLib" */ = {
			isa = XCLocalSwiftPackageReference;
			relativePath = "../CoreLib";
		};
/* End XCLocalSwiftPackageReference section */
`;

export const PACKAGE_PRODUCT_DEPENDENCY_SECTION = `
/* Begin XCSwiftPackageProductDependency section */
		FFFF11111111111111111111 /* Alamofire */ = {
			isa = XCSwiftPackageProductDependency;
			package = EEEEEEEEEEEEEEEEEEEEEEEA /* XCRemoteSwiftPackageReference "Alamofire" */;
			productName = Alamofire;
		};
		FFFF22222222222222222222 /* SnapKit */ = {
			isa = XCSwiftPackageProductDependency;
			package = EEEEEEEEEEEEEEEEEEEEEEE2 /* XCRemoteSwiftPackageReference "SnapKit" */;
			productName = SnapKit;
		};
/* End XCSwiftPackageProductDependency section */
`;

export const FRAMEWORKS_BUILD_PHASE_SECTION = `
/* Begin PBXFrameworksBuildPhase section */
		BBBB11111111111111111111 /* Frameworks */ = {
			isa = PBXFrameworksBuildPhase;
			buildActionMask = 2147483647;
			files = (
				AAAA33333333333333333333 /* AVFoundation.framework in Frameworks */,
				BBBB33333333333333333333 /* CoreData.framework in Frameworks */,
				CCCC33333333333333333333 /* libsqlite3.tbd in Frameworks */,
				DDDD33333333333333333333 /* Alamofire in Frameworks */,
			);
			runOnlyForDeploymentPostprocessing = 0;
		};
/* End PBXFrameworksBuildPhase section */
`;

export const RESOURCES_BUILD_PHASE_SECTION = `
/* Begin PBXResourcesBuildPhase section */
		CCCC11111111111111111111 /* Resources */ = {
			isa = PBXResourcesBuildPhase;
			buildActionMask = 2147483647;
			files = (
				AACC11111111111111111111 /* Assets.xcassets in Resources */,
				AACC22222222222222222222 /* Main.storyboard in Resources */,
				AACC33333333333333333333 /* config.json in Resources */,
				AACC44444444444444444444 /* Localizable.strings in Resources */,
			);
			runOnlyForDeploymentPostprocessing = 0;
		};
/* End PBXResourcesBuildPhase section */
`;

// Combined full pbxproj for integration-style tests
export const FULL_PBXPROJ = [
    '// !$*UTF8*$!',
    '{',
    'archiveVersion = 1;',
    'objectVersion = 56;',
    'objects = {',
    BUILD_CONFIGURATION_SECTION,
    CONFIGURATION_LIST_SECTION,
    PROJECT_SECTION,
    NATIVE_TARGET_SECTION,
    TARGET_DEPENDENCY_SECTION,
    REMOTE_PACKAGE_SECTION,
    LOCAL_PACKAGE_SECTION,
    PACKAGE_PRODUCT_DEPENDENCY_SECTION,
    FRAMEWORKS_BUILD_PHASE_SECTION,
    RESOURCES_BUILD_PHASE_SECTION,
    '};',
    'rootObject = AAAAAAAAAAAAAAAAAAAAAAAA /* Project object */;',
    '}',
].join('\n');
