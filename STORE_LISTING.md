# Chrome Web Store listing (copy and paste)

## Store listing tab

**Name:** Weft

**Summary** (132 characters max):
See what clothes are really made of. Tags every product with its fabric and filters for 100% cotton, linen, wool and more.

**Category:** Shopping

**Description:**

Shopping filters for "cotton" include anything with a little cotton in it. Weft reads each product's actual fabric label and tags it right on the product photo, so you can see at a glance what's 100% cotton and what's mostly polyester.

• A fabric tag on every product: 100% COTTON, 60% COTTON, HAS POLYESTER, with a color bar showing the blend
• Choose what you want: cotton, linen, wool, cashmere, silk, hemp, alpaca, mohair, lyocell, modal, viscose, or "All natural"
• Set a minimum %, then fade or hide everything below it
• Avoid polyester, nylon, acrylic, spandex, or all synthetics
• Allow a little stretch (2%, 5% or 10% spandex)
• See where items are made, and filter for made in USA
• Fabric content panel on product pages, with a short guide to each fiber
• Run automatically on the stores you choose
• Works on Amazon, Target, Walmart, Uniqlo, H&M, Everlane, Shopify stores and most other clothing sites

Free, open source, no account, no tracking. Weft has no servers. Everything happens in your browser.

**Privacy policy URL:** https://github.com/YOUR-USERNAME/weft/blob/main/PRIVACY.md

**Homepage URL:** https://github.com/YOUR-USERNAME/weft

## Privacy practices tab

**Single purpose:**
Shows the fabric composition of clothing products on shopping pages and lets the user filter products by material.

**Permission justifications:**

- **activeTab**: Weft runs only on the tab where the user clicks its toolbar button, to read the products on that store page.
- **scripting**: Injects Weft's panel and product labels into the current store page when the user clicks the button, and on stores where the user turned on "Run automatically".
- **storage**: Saves the user's filter settings and caches fabric results for a week, locally on the device.
- **Host permissions (optional)**: Requested only if the user turns on "Run automatically" for a specific store, and only for that store, so Weft can open by itself there. Never requested at install.

**Remote code:** No, I am not using remote code. All code is included in the package.

**Data usage:** Weft reads *website content* (store product pages) only to show fabric information to the user. Nothing is collected, transmitted or sold. Tick the three certification boxes (not sold, not used for unrelated purposes, not used for creditworthiness).

## Images you need

- **Store icon:** 128×128 `extension/icons/weft-128.png`
- **Screenshots:** at least 1, 1280×800 (take them on a store page with Weft open)
- **Small promo tile** (optional): 440×280
