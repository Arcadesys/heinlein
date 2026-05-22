-- Wrap the first prose paragraph after each chapter header in a
-- <div class="first"> so CSS can scope the drop-cap to chapter openings.
-- Also tags the first prose paragraph after a top-level title header,
-- skipping single-Emph paragraphs that look like a byline.

local mark_next = true  -- tag the very first prose paragraph too

function Header(el)
  if el.level <= 2 then
    mark_next = true
  end
  return el
end

local function is_byline(para)
  return #para.content == 1 and para.content[1].t == 'Emph'
end

function Para(el)
  if not mark_next then return nil end
  if is_byline(el) then return nil end
  mark_next = false
  return pandoc.Div({el}, pandoc.Attr("", {"first"}, {}))
end
