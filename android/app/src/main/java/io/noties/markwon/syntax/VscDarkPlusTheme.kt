package io.noties.markwon.syntax

/**
 * 代码高亮主题：对齐 PWA 的 react-syntax-highlighter vscDarkPlus 色表。
 * 背景透明——代码块背景/边框由 MarkwonTheme.codeBackground 统一控制（#242526）。
 *
 * 注意：必须放在 io.noties.markwon.syntax 包内，
 * 因为 Prism4jThemeBase.ColorHashMap 的构造函数是 protected（仅同包/子类可访问）。
 */
class VscDarkPlusTheme : Prism4jThemeBase() {
    override fun background() = 0x00000000

    override fun textColor() = 0xFFBFBFBF.toInt()

    override fun init() = ColorHashMap()
        .add(0xFF6A9955.toInt(), "comment", "prolog", "doctype", "cdata")
        .add(0xFFD4D4D4.toInt(), "punctuation")
        .add(0xFF569CD6.toInt(), "property", "tag", "boolean", "number", "constant", "symbol", "deleted")
        .add(0xFFCE9178.toInt(), "selector", "attr-name", "string", "char", "builtin", "inserted")
        .add(0xFFD4D4D4.toInt(), "operator", "entity", "url")
        .add(0xFFC586C0.toInt(), "atrule", "attr-value", "keyword")
        .add(0xFFDCDCAA.toInt(), "function", "class-name")
        .add(0xFFD4D4D4.toInt(), "regex", "important", "variable")
}
