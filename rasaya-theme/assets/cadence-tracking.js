// Cadence CRM event tracking (PRD-01 §7).
//
// Fires page_view on every load, product_view on the product template,
// add_to_cart on Dawn's cart-update pubsub event (covers every add-to-cart
// path in the theme — the main product form, quick add, and the bulk/quick
// order list — without patching each one individually), and checkout_started
// as a best-effort signal on click of any checkout button.
//
// Fire-and-forget by design: this endpoint is a demo/analytics sink, not
// something a storefront visitor's experience should ever depend on. Every
// failure mode (missing endpoint, network error, CORS) is swallowed.
(function () {
  var ctx = window.CadenceTracking;
  if (!ctx || !ctx.endpoint) return;

  function send(type, payload) {
    var body = JSON.stringify({
      type: type,
      session_id: ctx.sessionId,
      customer_id: ctx.customerId,
      payload: payload || {},
    });
    try {
      if (navigator.sendBeacon) {
        var blob = new Blob([body], { type: 'application/json' });
        var ok = navigator.sendBeacon(ctx.endpoint, blob);
        if (ok) return;
      }
    } catch (e) {
      /* fall through to fetch */
    }
    try {
      fetch(ctx.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: body,
        keepalive: true,
      }).catch(function () {
        /* best-effort — never blocks or errors the page */
      });
    } catch (e) {
      /* best-effort — never blocks or errors the page */
    }
  }

  // PRD-01 §7: page_view carries the product id on PDPs.
  send('page_view', {
    template: ctx.template,
    url: window.location.href,
    title: document.title,
    product_id: (ctx.template === 'product' && ctx.product && ctx.product.id) || null,
  });

  if (ctx.template === 'product' && ctx.product) {
    send('product_view', ctx.product);
  }

  document.addEventListener(
    'DOMContentLoaded',
    function () {
      if (typeof subscribe === 'function' && typeof PUB_SUB_EVENTS !== 'undefined') {
        subscribe(PUB_SUB_EVENTS.cartUpdate, function (event) {
          var source = (event && event.source) || null;
          // Only these two sources are genuine "add to cart" actions — the
          // theme also publishes cartUpdate for a plain quantity change on
          // the cart page (source: "cart-items"), which is not an add.
          if (source !== 'product-form' && source !== 'quick-add') return;

          // The two add-to-cart paths shipped in Dawn hand back different
          // shapes: product-form.js's cartData IS the newly added line item
          // (the raw /cart/add.js response); quick-add's cartData is the
          // FULL cart (/cart/update.js response), so the item just added is
          // its last line.
          var item = null;
          var cartData = event && event.cartData;
          if (cartData) {
            item =
              source === 'product-form'
                ? cartData
                : Array.isArray(cartData.items) && cartData.items.length > 0
                  ? cartData.items[cartData.items.length - 1]
                  : null;
          }

          send('add_to_cart', {
            source: source,
            variant_id: (event && event.productVariantId) || (item && item.variant_id) || null,
            title: item && item.product_title,
            sku: item && item.sku,
            qty: item && item.quantity,
            price: item && typeof item.price === 'number' ? item.price / 100 : undefined,
          });
        });
      }

      // Best-effort: fires on click, just before the browser navigates away
      // to Shopify's hosted checkout, so there is no "after" hook to use.
      document.body.addEventListener('click', function (evt) {
        var target =
          evt.target.closest &&
          evt.target.closest('[name="checkout"], .cart__checkout-button, [href*="/checkout"]');
        if (target) {
          send('checkout_started', { source: 'storefront' });
        }
      });
    },
    { once: true },
  );
})();
