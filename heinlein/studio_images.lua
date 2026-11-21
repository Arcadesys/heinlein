-- Studio stages only validated project images in the converter's private cwd.
function Image(image)
  local index = image.src:match("^heinlein%-illustration%-(%d+)$")
  if not index then error("Unresolved illustration: " .. image.src) end
  for _, ext in ipairs({"png", "jpg"}) do
    local name = "illustrations/" .. index .. "." .. ext
    local file = io.open(name, "rb")
    if file then
      local bytes = file:read("*all")
      file:close()
      pandoc.mediabag.insert(name, ext == "png" and "image/png" or "image/jpeg", bytes)
      image.src = name
      return image
    end
  end
  error("Missing staged illustration " .. index)
end
