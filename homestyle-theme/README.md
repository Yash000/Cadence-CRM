# HomeStyle Furniture — Shopify theme

A fork of Shopify's [Dawn](https://github.com/Shopify/dawn) reference theme, lightly
customised for the **HomeStyle Furniture** demo store and wired to
[Cadence CRM](../README.md). Everything not listed below is stock Dawn.

## Cadence additions

### CRM event tracking (PRD-01 §7)

Client-side, fire-and-forget tracking that posts `page_view`, `product_view`,
`add_to_cart` and `checkout_started` to the Cadence CRM `/api/events` endpoint.

| File | Role |
|---|---|
| `snippets/cadence-tracking.liquid` | Bootstraps `window.CadenceTracking` (endpoint, session id, customer/product context) and loads the script. Rendered from `layout/theme.liquid`. |
| `assets/cadence-tracking.js` | Sends the events. A blank, unreachable or slow endpoint never blocks or errors the page. |

Configure under **Theme settings → Cadence CRM tracking**:
`cadence_events_enabled` + `cadence_events_endpoint`. Both blank by default, so a
fresh install of the theme is inert until pointed at a running CRM. The in-app
event simulator (`/simulator`) is the offline fallback when the theme has no
public URL to reach.

### Product disclosures

Surfaces the Shopify `disclosure` product metafields (materials, care, origin) on
the product page and in the cart.

| File | Role |
|---|---|
| `sections/disclosures.liquid`, `snippets/product-disclosures.liquid` | PDP disclosure block |
| `snippets/cart-disclosure-indicator.liquid`, `assets/cart-disclosure-modal.js`, `assets/cart-disclosure-tooltip.js`, `assets/component-disclosures.css` | Cart-line disclosure indicator + modal/tooltip |

## Local development

```sh
cd homestyle-theme
shopify theme dev --store rasaya-dev.myshopify.com
```

(The dev store is still named `rasaya-dev` from before the HomeStyle rebrand.)

## Staying up to date with Dawn

```sh
git remote add upstream https://github.com/Shopify/dawn.git   # once
git fetch upstream && git merge upstream/main
```

## License

Dawn is provided under the [MIT License](LICENSE.md).
