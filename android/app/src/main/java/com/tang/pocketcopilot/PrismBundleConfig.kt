package com.tang.pocketcopilot

import io.noties.prism4j.annotations.PrismBundle

/**
 * 由 prism4j-bundler（kapt）在编译期生成 GrammarLocatorDef，
 * 提供聊天中常见语言的 Prism4j 语法定义。
 */
@PrismBundle(
    include = [
        "markup", "css", "javascript", "java", "kotlin", "python",
        "c", "cpp", "csharp", "go", "sql", "json", "yaml",
        "markdown", "git", "makefile",
    ],
)
object PrismBundleConfig
