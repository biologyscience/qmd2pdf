function Div(el)

  if el.classes:includes("center") then
    return {
      pandoc.RawBlock("latex", "\\begin{center}"),
      el,
      pandoc.RawBlock("latex", "\\end{center}")
    }
  end

  if el.classes:includes("row") then
    local left = nil
    local right = nil

    local left_size = tonumber(el.attributes["split"]) or 0.5

    for _, child in ipairs(el.content) do
        if child.t == "Div" then
            if child.classes:includes("left") then
                left = child
            elseif child.classes:includes("right") then
                right = child
            end
        end
    end

    if not left or not right then
        return nil
    end

    local left_content = pandoc.write(
        pandoc.Pandoc(left.content),
        "latex"
    )

    local right_content = pandoc.write(
        pandoc.Pandoc(right.content),
        "latex"
    )

    local latex =
        "\\noindent\n" ..
        "\\begin{minipage}[t]{" ..
        left_size ..
        "\\linewidth}\n" ..
        "\\vspace{0pt}\n" ..
        left_content ..
        "\\end{minipage}" ..
        "\\hfill\n" ..
        "\\begin{minipage}[t]{\\dimexpr " ..
        (1 - left_size) ..
        "\\linewidth - 0.02\\linewidth\\relax}\n" ..
        "\\vspace{0pt}\n" ..
        right_content ..
        "\\end{minipage}\n"

    return pandoc.RawBlock("latex", latex)
  end

  if el.classes:includes("small") then
    return {
      pandoc.RawBlock("latex", "\\begin{small}"),
      el,
      pandoc.RawBlock("latex", "\\end{small}")
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
  
  return el
end

function Table(tbl)

  if not (FORMAT:match("latex") or FORMAT:match("beamer")) then
    return nil
  end

  local function blocks_to_latex(blocks)
    local doc = pandoc.Pandoc(blocks)
    local latex = pandoc.write(doc, "latex")
    latex = latex:gsub("%s+$", "")
    return latex
  end

  local align_map = {
    AlignLeft = "l",
    AlignRight = "r",
    AlignCenter = "c",
    AlignDefault = "l"
  }

  local colspec_str = "|"
  for _, colspec in ipairs(tbl.colspecs) do
    local align = align_map[colspec[1]] or "l"
    colspec_str = colspec_str .. align .. "|"
  end

  local rows_latex = {}

  if tbl.head and tbl.head.rows and #tbl.head.rows > 0 then
    for _, row in ipairs(tbl.head.rows) do
      local cells = {}
      for _, cell in ipairs(row.cells) do
        table.insert(cells, "\\textbf{" .. blocks_to_latex(cell.contents) .. "}")
      end
      table.insert(rows_latex, table.concat(cells, " & ") .. " \\\\\n\\hline")
    end
  end

  for _, body in ipairs(tbl.bodies) do
    for _, row in ipairs(body.body) do
      local cells = {}
      for _, cell in ipairs(row.cells) do
        table.insert(cells, blocks_to_latex(cell.contents))
      end
      table.insert(rows_latex, table.concat(cells, " & ") .. " \\\\\n\\hline")
    end
  end

  local caption_latex = ""
  if tbl.caption and tbl.caption.long and #tbl.caption.long > 0 then
    caption_latex = "\\textbf{" .. blocks_to_latex(tbl.caption.long) .. "}\\par\\medskip\n"
  end

  local latex = "\\begingroup\n\\centering\n"
    .. caption_latex
    .. "\\begin{tabular}{" .. colspec_str .. "}\n"
    .. "\\hline\n"
    .. table.concat(rows_latex, "\n")
    .. "\n\\end{tabular}\n\\par\n\\endgroup"

  return pandoc.RawBlock("latex", latex)
end

function Str(el)
    local value = el.text:match("^{{(.+)}}$")

    if value then
        return pandoc.RawInline(
            "latex",
            "\\vspace{" .. value .. "}"
        )
    end

    return nil
end