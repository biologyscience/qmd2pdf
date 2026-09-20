function Div(el)

  if el.classes:includes("center") then
    return {
      pandoc.RawBlock("latex", "\\begin{center}"),
      el,
      pandoc.RawBlock("latex", "\\end{center}")
    }
  end

  if el.classes:includes("mybox") then
    local result = {}

    table.insert(result, pandoc.RawBlock("latex", "\\begin{mybox}"))

    for _, block in ipairs(el.content) do
      table.insert(result, block)
    end

    table.insert(result, pandoc.RawBlock("latex", "\\end{mybox}"))

    return result
  end

end