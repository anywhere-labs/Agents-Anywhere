type MathNode = {
  type: string
  children?: MathNode[]
  position?: { start: { offset?: number }; end: { offset?: number } }
  data?: { hProperties?: Record<string, unknown> }
}

// remark-math treats same-line $$...$$ as inline math. Chat replies also
// use this syntax for standalone display equations; preserve code and prose.
export function remarkStandaloneDisplayMath() {
  return (tree: MathNode, file: { value: unknown }) => {
    const source = String(file.value)
    function visit(node: MathNode) {
      if (node.type === "paragraph" && node.children?.length === 1) {
        const math = node.children[0]
        if (!math) return
        const start = math.position?.start.offset
        const end = math.position?.end.offset
        if (math.type === "inlineMath" && start !== undefined && end !== undefined) {
          const raw = source.slice(start, end)
          if (raw.startsWith("$$") && raw.endsWith("$$")) {
            math.data = {
              ...math.data,
              hProperties: { ...math.data?.hProperties, className: ["language-math", "math-display"] },
            }
          }
        }
      }
      node.children?.forEach(visit)
    }
    visit(tree)
  }
}
