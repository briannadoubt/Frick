import SwiftCompilerPlugin
import SwiftSyntaxMacros

@main
struct FrickMacrosPlugin: CompilerPlugin {
    let providingMacros: [Macro.Type] = [
        FrickModelMacro.self,
    ]
}
