/**
 * Xcode build setting → compiler flag table, transcribed from Xcode's own
 * `Swift.xcspec` — the file the build system evaluates to construct the swiftc
 * invocation. Source (Xcode 26.6):
 *
 *   /Applications/Xcode.app/Contents/SharedFrameworks/SwiftBuild.framework/Versions/A/
 *     PlugIns/SWBBuildService.bundle/Contents/PlugIns/SWBUniversalPlatformPlugin.bundle/
 *     Contents/Frameworks/SWBUniversalPlatform.framework/Versions/A/Resources/Swift.xcspec
 *
 * To refresh after an Xcode upgrade: `plutil -convert json -o - <spec>` and re-read the
 * `Options` array of the `com.apple.xcode.tools.swift.compiler` entry.
 *
 * Curated to settings that change **typechecking or diagnostics**. Build- and
 * packaging-only settings are deliberately absent — forwarding them would change what the
 * indexing build produces without making the editor agree with xcodebuild any more than it
 * already does: `-enable-testing`, library evolution, sanitizers, index-store paths,
 * whole-module optimization, `SWIFT_OPTIMIZATION_LEVEL`, `SWIFT_COMPILATION_MODE`.
 *
 * `SWIFT_VERSION` and `SWIFT_APPROACHABLE_CONCURRENCY` are not rows: the first becomes
 * `.swiftLanguageMode`, the second has no flags of its own and instead supplies the
 * default for the five rows marked `umbrella`.
 */

export interface SwiftSettingFlagRow {
    /** Xcode build setting name, exactly as it appears in project.pbxproj. */
    setting: string;
    /** Value → flags Xcode emits. Keys are upper-cased; lookup upper-cases too, because
     *  the spec spells one default `No` against `YES`/`MIGRATE`/`NO` value keys. */
    values: Record<string, string[]>;
    /** Flags for any value absent from `values` — the spec's `<<otherwise>>` branch. */
    otherwise?: string[];
    /** The default **already resolved**: the spec writes these as `$(…)` expressions, and
     *  SWIFT_STRICT_CONCURRENCY's would fall through `otherwise` and hand every Swift-5
     *  target a StrictConcurrency it never asked for. */
    defaultValue: string;
    /** Xcode consults this setting only at language mode 4/4.2/5; at 6 the behaviour is
     *  already the language default and no flag is emitted. */
    v45Only?: boolean;
    /** SWIFT_APPROACHABLE_CONCURRENCY = YES supplies this row's default. */
    umbrella?: boolean;
    /** List-valued setting: each item is emitted as `<listFlag> <item>`. */
    listFlag?: string;
}

/** MIGRATE is only offered for the features whose spec entry allows it. */
function upcoming(
    setting: string,
    feature: string,
    options: { v45Only?: boolean; umbrella?: boolean; migrate?: boolean } = {}
): SwiftSettingFlagRow {
    const values: Record<string, string[]> = {
        YES: ['-enable-upcoming-feature', feature],
        NO: []
    };
    if (options.migrate) {
        values.MIGRATE = ['-enable-upcoming-feature', `${feature}:migrate`];
    }
    return {
        setting,
        values,
        defaultValue: 'NO',
        v45Only: options.v45Only,
        umbrella: options.umbrella
    };
}

export const SWIFT_SETTING_FLAG_ROWS: SwiftSettingFlagRow[] = [
    // ── Language mode / semantics ──
    {
        setting: 'SWIFT_DEFAULT_ACTOR_ISOLATION',
        values: { NONISOLATED: [], MAINACTOR: ['-default-isolation=MainActor'] },
        defaultValue: 'nonisolated'
    },
    {
        setting: 'SWIFT_STRICT_CONCURRENCY',
        values: { MINIMAL: [], TARGETED: ['-strict-concurrency=targeted'] },
        otherwise: ['-enable-upcoming-feature', 'StrictConcurrency'],
        // Resolved: 'complete' at language mode 6, but the row is v45Only so mode 6 never
        // reads it; 'minimal' — no flag — everywhere it is read.
        defaultValue: 'minimal',
        v45Only: true
    },
    {
        setting: 'SWIFT_STRICT_MEMORY_SAFETY',
        values: {
            YES: ['-strict-memory-safety'],
            MIGRATE: ['-strict-memory-safety:migrate'],
            NO: []
        },
        defaultValue: 'NO'
    },
    {
        setting: 'SWIFT_ENABLE_BARE_SLASH_REGEX',
        values: { YES: ['-enable-bare-slash-regex'], NO: [] },
        // Default-on: Xcode passes this for every v4/4.2/5 target.
        defaultValue: 'YES',
        v45Only: true
    },
    {
        setting: 'SWIFT_OBJC_INTEROP_MODE',
        // Spec writes these as bare strings rather than arrays; normalised here.
        values: { OBJC: [], OBJCXX: ['-cxx-interoperability-mode=default'] },
        defaultValue: 'objc'
    },

    // ── Diagnostics severity ──
    {
        setting: 'SWIFT_TREAT_WARNINGS_AS_ERRORS',
        values: { YES: ['-warnings-as-errors'], NO: [] },
        defaultValue: 'NO'
    },
    {
        setting: 'SWIFT_WARNINGS_AS_ERRORS_GROUPS',
        values: {},
        defaultValue: '',
        listFlag: '-Werror'
    },
    {
        setting: 'SWIFT_WARNINGS_AS_WARNINGS_GROUPS',
        values: {},
        defaultValue: '',
        listFlag: '-Wwarning'
    },

    // ── Upcoming features, gated to language mode 4/4.2/5 (on by default at 6) ──
    upcoming('SWIFT_UPCOMING_FEATURE_CONCISE_MAGIC_FILE', 'ConciseMagicFile', { v45Only: true }),
    upcoming('SWIFT_UPCOMING_FEATURE_FORWARD_TRAILING_CLOSURES', 'ForwardTrailingClosures', { v45Only: true }),
    upcoming('SWIFT_UPCOMING_FEATURE_DEPRECATE_APPLICATION_MAIN', 'DeprecateApplicationMain', { v45Only: true }),
    // Spelling diverges: SCREAMING_SNAKE → CamelCase would yield a name the compiler rejects.
    upcoming('SWIFT_UPCOMING_FEATURE_IMPORT_OBJC_FORWARD_DECLS', 'ImportObjcForwardDeclarations', { v45Only: true }),
    upcoming('SWIFT_UPCOMING_FEATURE_ISOLATED_DEFAULT_VALUES', 'IsolatedDefaultValues', { v45Only: true }),
    upcoming('SWIFT_UPCOMING_FEATURE_GLOBAL_CONCURRENCY', 'GlobalConcurrency', { v45Only: true }),
    upcoming('SWIFT_UPCOMING_FEATURE_IMPLICIT_OPEN_EXISTENTIALS', 'ImplicitOpenExistentials', { v45Only: true }),
    upcoming('SWIFT_UPCOMING_FEATURE_REGION_BASED_ISOLATION', 'RegionBasedIsolation', { v45Only: true }),
    upcoming('SWIFT_UPCOMING_FEATURE_DYNAMIC_ACTOR_ISOLATION', 'DynamicActorIsolation', { v45Only: true }),
    upcoming('SWIFT_UPCOMING_FEATURE_NONFROZEN_ENUM_EXHAUSTIVITY', 'NonfrozenEnumExhaustivity', { v45Only: true }),

    // ── Approachable-concurrency umbrella members, gated to 4/4.2/5 ──
    // Also a divergent spelling: the setting says ACTOR_ISOLATION, the feature says Inference.
    upcoming('SWIFT_UPCOMING_FEATURE_DISABLE_OUTWARD_ACTOR_ISOLATION', 'DisableOutwardActorInference', { v45Only: true, umbrella: true }),
    upcoming('SWIFT_UPCOMING_FEATURE_INFER_SENDABLE_FROM_CAPTURES', 'InferSendableFromCaptures', { v45Only: true, umbrella: true }),
    upcoming('SWIFT_UPCOMING_FEATURE_GLOBAL_ACTOR_ISOLATED_TYPES_USABILITY', 'GlobalActorIsolatedTypesUsability', { v45Only: true, umbrella: true }),

    // ── Upcoming features with no version gate (not implied by any language mode) ──
    upcoming('SWIFT_UPCOMING_FEATURE_INTERNAL_IMPORTS_BY_DEFAULT', 'InternalImportsByDefault'),
    upcoming('SWIFT_UPCOMING_FEATURE_MEMBER_IMPORT_VISIBILITY', 'MemberImportVisibility', { migrate: true }),
    upcoming('SWIFT_UPCOMING_FEATURE_EXISTENTIAL_ANY', 'ExistentialAny', { migrate: true }),

    // ── Ungated umbrella members: these two are why Swift 6 targets still get flags ──
    upcoming('SWIFT_UPCOMING_FEATURE_INFER_ISOLATED_CONFORMANCES', 'InferIsolatedConformances', { migrate: true, umbrella: true }),
    upcoming('SWIFT_UPCOMING_FEATURE_NONISOLATED_NONSENDING_BY_DEFAULT', 'NonisolatedNonsendingByDefault', { migrate: true, umbrella: true }),

    // ── Experimental features ──
    {
        setting: 'SWIFT_EXPERIMENTAL_FEATURE_DEBUG_DESCRIPTION_MACRO',
        values: { YES: ['-enable-experimental-feature', 'DebugDescriptionMacro'], NO: [] },
        // Default-on in every configuration; an unknown experimental feature is ignored by
        // the compiler, so emitting it cannot break a manifest on a future toolchain.
        defaultValue: 'YES'
    }
];

/** The five rows whose default comes from SWIFT_APPROACHABLE_CONCURRENCY. */
export const APPROACHABLE_CONCURRENCY_SETTING = 'SWIFT_APPROACHABLE_CONCURRENCY';

/**
 * SWIFT_* settings handled elsewhere or intentionally not forwarded. Keeps the
 * unmapped-setting log to things a human should actually look at.
 */
export const KNOWN_IGNORED_SWIFT_SETTINGS = new Set([
    // Handled by dedicated code paths.
    'SWIFT_VERSION',
    'SWIFT_ACTIVE_COMPILATION_CONDITIONS',
    APPROACHABLE_CONCURRENCY_SETTING,
    // Build/packaging concerns that do not affect typechecking.
    'SWIFT_OPTIMIZATION_LEVEL',
    'SWIFT_COMPILATION_MODE',
    'SWIFT_WHOLE_MODULE_OPTIMIZATION',
    'SWIFT_CROSS_MODULE_OPTIMIZATION',
    'SWIFT_ENABLE_TESTABILITY',
    'SWIFT_ENABLE_LIBRARY_EVOLUTION',
    'SWIFT_INSTALL_OBJC_HEADER',
    'SWIFT_OBJC_BRIDGING_HEADER',
    'SWIFT_OBJC_INTERFACE_HEADER_NAME',
    'SWIFT_OBJC_INTERFACE_HEADER_DIR',
    'SWIFT_PRECOMPILE_BRIDGING_HEADER',
    'SWIFT_EMIT_LOC_STRINGS',
    'SWIFT_INDEX_STORE_ENABLE',
    'SWIFT_SERIALIZE_DEBUGGING_OPTIONS',
    'SWIFT_REFLECTION_METADATA_LEVEL',
    'SWIFT_DISABLE_SAFETY_CHECKS',
    'SWIFT_ENFORCE_EXCLUSIVE_ACCESS',
    'SWIFT_SUPPRESS_WARNINGS',
    'SWIFT_MODULE_NAME',
    'SWIFT_MODULE_ALIASES',
    'SWIFT_LIBRARIES_ONLY',
    'SWIFT_INCLUDE_PATHS',
    'SWIFT_USE_PARALLEL_WHOLE_MODULE_OPTIMIZATION'
]);
