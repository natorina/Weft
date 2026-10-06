# Weft

**See what clothes are really made of.**

Weft is a free, open-source browser extension that reads the fabric composition of every product on a clothing store page and labels it right on the product photo. You can then fade or hide everything that isn't what you want: 100% cotton, linen, wool, natural fibers only, no polyester, and so on.

Shopping filters for "cotton" usually include anything with a little cotton in it. Weft checks each product's actual fabric label instead.

## Features

- **Fabric tag on every product**, e.g. `100% COTTON`, `60% COTTON`, `HAS POLYESTER`, with a color bar showing the full blend
- **Choose what you're looking for**: cotton, linen, wool, cashmere, silk, hemp, alpaca, mohair, lyocell, modal, viscose, or any mix, plus an "All natural" option
- **Minimum %** slider, and **Fade** or **Hide** for everything below it
- **Avoid list**: rule out anything containing polyester, nylon, acrylic, spandex, viscose, or all synthetics
- **Stretch allowance**: let 2%, 5% or 10% spandex still count as a match
- **Made in**: shows where items are made, with an "only made in USA" filter
- **Fabric content panel** on product pages, with a short guide to each fiber
- **Run automatically** on the stores you choose
- Handles **linings and trims** ("100% cotton shell, polyester lining") and **colors that differ** ("heather grey is 90/10")
- Works on **any store**, including Amazon, Target, Walmart, Uniqlo, H&M, Everlane and Shopify stores
- **Private**: no account, no tracking, no servers. Everything runs in your browser.

Every feature is free.

## Install

Weft works in Chrome, Vivaldi, Edge, Brave and Arc.

1. Download this repository (green **Code** button, then **Download ZIP**) and unzip it
2. Go to `chrome://extensions` (Vivaldi: `vivaldi://extensions`)
3. Turn on **Developer mode** (top right)
4. Click **Load unpacked** and choose the `extension` folder
5. Pin Weft to your toolbar

## Use

Open a category or search page on any clothing site and click the Weft icon (or press <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>C</kbd>). Weft checks each product and tags it. Products that load as you scroll are checked too. Hover a tag to see the full composition.

To have Weft open by itself on a store, tick **Run automatically on this store** in the panel.

## How it works

1. **Find products**: Weft looks for product tiles (large image links to product pages) on the page, including tiles inside shadow DOM.
2. **Read each product page**: it fetches each product's page from the same store in the background, a couple at a time. If the store shows a "verify you're human" page, it pauses.
3. **Parse the fabric**: [`parser.js`](extension/parser.js) finds percentage/fiber pairs in either order ("60% cotton", "Cotton 60%"), groups them into lists that add up to 100%, and uses nearby labels ("Shell", "Lining", "Fabric type") to tell the main fabric from linings and trims. It skips menus, footers and customer reviews.
4. **Score it** against your choices and tag the product.

Results are cached in your browser for a week.

## Development

No build step. Edit the files in `extension/`, then press reload on the extension card in `chrome://extensions`.

Run the parser tests (requires Node.js):

```bash
node tests/parser.test.js
```

## Privacy

Weft has no servers and collects nothing. See [PRIVACY.md](PRIVACY.md).

## License

[MIT](LICENSE)
