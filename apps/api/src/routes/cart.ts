import type { FastifyInstance } from 'fastify';
import { clearCart, createQuote, priceCart, setCartItem } from '../cart.js';
import type { Db } from '../db.js';
import type { PaymentProvider } from '../payments.js';
import { AppError } from '../errors.js';
import { retailerAccountIdOf } from '../retailer-context.js';

const MAX_CART_LINES = 300;

export async function cartRoutes(app: FastifyInstance, opts: { db: Db; payments: PaymentProvider }): Promise<void> {
  const { db } = opts;
  // Lets the app hide online payment until a provider is configured.
  const onlinePaymentAvailable = opts.payments.enabled;

  app.get('/cart', async (request) => {
    const accountId = retailerAccountIdOf(request);
    return { cart: await priceCart(db, accountId), onlinePaymentAvailable };
  });

  app.put<{ Params: { productId: string }; Body: { quantity: number } }>(
    '/cart/items/:productId',
    {
      schema: {
        params: {
          type: 'object',
          required: ['productId'],
          properties: { productId: { type: 'string', format: 'uuid' } },
        },
        body: {
          type: 'object',
          required: ['quantity'],
          additionalProperties: false,
          properties: { quantity: { type: 'integer', minimum: 0, maximum: 10000 } },
        },
      },
    },
    async (request) => {
      const accountId = retailerAccountIdOf(request);
      const { productId } = request.params;
      const { quantity } = request.body;
      if (quantity > 0) {
        const product = await db.query('SELECT 1 FROM products WHERE id = $1', [productId]);
        if (product.rowCount === 0) throw new AppError('NOT_FOUND', 'Product not found');
        const count = await db.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM cart_items ci JOIN carts c ON c.id = ci.cart_id
           WHERE c.retailer_account_id = $1 AND ci.product_id <> $2`,
          [accountId, productId],
        );
        if (count.rows[0]!.n >= MAX_CART_LINES) {
          throw new AppError('VALIDATION_FAILED', `A cart can hold at most ${MAX_CART_LINES} products`);
        }
      }
      await setCartItem(db, accountId, productId, quantity);
      return { cart: await priceCart(db, accountId), onlinePaymentAvailable };
    },
  );

  app.delete('/cart', async (request, reply) => {
    const accountId = retailerAccountIdOf(request);
    await clearCart(db, accountId);
    return reply.status(204).send();
  });

  app.post('/cart/quote', async (request, reply) => {
    const accountId = retailerAccountIdOf(request);
    return reply.status(201).send({ quote: await createQuote(db, accountId) });
  });
}
