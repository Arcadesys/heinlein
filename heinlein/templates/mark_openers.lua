-- Wrap the first prose paragraph after each chapter header in a
-- <div class="first"> so CSS can scope the drop-cap to chapter openings.
-- Skips bylines, italic epigraphs, and short attribution lines so the
-- drop-cap lands on the real opening prose.

local mark_next = true  -- tag the very first prose paragraph too

function Header(el)
  if el.level <= 2 then
    mark_next = true
  end
  return el
end

local function plain_text(para)
  return pandoc.utils.stringify(para)
end

local function is_attribution(para)
  local text = plain_text(para)
  if #text == 0 then return true end
  local first = text:sub(1, 1)
  if first == '~' or first == '—' then return true end
  if text:sub(1, 2) == '--' then return true end
  return false
end

local function is_epigraph(para)
  if #para.content == 0 then return false end
  if para.content[1].t ~= 'Emph' then return false end
  if #para.content == 1 then return true end
  local tail = ""
  for i = 2, #para.content do
    tail = tail .. pandoc.utils.stringify(para.content[i])
  end
  return #tail < 30
end

function Para(el)
  if not mark_next then return nil end
  if is_epigraph(el) or is_attribution(el) then return nil end
  mark_next = false
  return pandoc.Div({el}, pandoc.Attr("", {"first"}, {}))
end
