import { Router } from "express";
import type { JobRunner } from "../../jobs/JobRunner.js";
import { filterOptions, parseQuery, queryProducts } from "../../storage/query.js";

/**
 * Read routes for the product grid.
 *
 * Filtering/sorting/paging all happen server-side over the in-memory index, so
 * the browser only ever receives one visible page of rows — the grid stays
 * responsive at thousands of products.
 */
export function productRoutes(runner: JobRunner): Router {
  const router = Router();

  // GET /api/products?priceMin=..&quality=A,B&sortBy=price&sortDir=desc&offset=0&limit=50
  router.get("/products", (req, res) => {
    const query = parseQuery(req.query as Record<string, unknown>);
    const result = queryProducts(runner.products.all(), {
      ...query,
      limit: query.limit ?? 50,
    });
    res.json(result);
  });

  /** Distinct values for the multi-select filters, derived from live data. */
  router.get("/products/filter-options", (_req, res) => {
    res.json(filterOptions(runner.products.all()));
  });

  /** One product with its full detail payload (funnel / rank / return reasons). */
  router.get("/products/:key", (req, res) => {
    const key = req.params.key;
    const found = runner.products
      .all()
      .find((row) => row.pid === key || row.url === key);
    if (!found) {
      res.status(404).json({ error: `No product found for "${key}".` });
      return;
    }
    res.json(found);
  });

  return router;
}
