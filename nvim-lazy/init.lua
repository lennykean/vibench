-- vibench nvim profile, LazyVim flavor (`vibench reset-nvim --lazy`).
-- Bootstraps lazy.nvim, then LazyVim with its default plugin suite.
-- Customize in lua/config/ and lua/plugins/; `vibench reset-nvim` returns
-- to the stock profile.
local lazypath = vim.fn.stdpath("data") .. "/lazy/lazy.nvim"
if not (vim.uv or vim.loop).fs_stat(lazypath) then
  vim.fn.system({
    "git", "clone", "--filter=blob:none",
    "https://github.com/folke/lazy.nvim.git", "--branch=stable", lazypath,
  })
end
vim.opt.rtp:prepend(lazypath)

require("lazy").setup({
  spec = {
    { "LazyVim/LazyVim", import = "lazyvim.plugins" },
    { import = "plugins" },
  },
  defaults = { lazy = false, version = false },
  checker = { enabled = false },
})
