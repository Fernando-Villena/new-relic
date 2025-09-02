import express from "express";
import fetch from "node-fetch";
import cors from "cors";
import path from "path";
import dotenv from "dotenv";

dotenv.config(); 

const app = express();
const PORT = process.env.PORT || 3000;
const NEW_RELIC_API_KEY = process.env.NEW_RELIC_API_KEY;
const ACCOUNT_ID = process.env.ACCOUNT_ID;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(path.resolve(), "public")));

app.get("/", (req, res) => {
  res.sendFile(path.join(path.resolve(), "public/index.html"));
});

app.post("/alerts", async (req, res) => {
  const { policyId } = req.body;
  if (!policyId) return res.status(400).json({ error: "policyId es requerido" });

  let allConditions = [];
  let cursor = null;

  try {
    do {
      const query = `
      {
        actor {
          account(id: ${ACCOUNT_ID}) {
            alerts {
              nrqlConditionsSearch(searchCriteria: { policyId: "${policyId}" }, cursor: ${cursor ? `"${cursor}"` : null}) {
                nrqlConditions {
                  id
                  name
                  description
                  enabled
                  type
                  runbookUrl
                  nrql { query }
                  terms {
                    operator
                    threshold
                    priority
                    thresholdDuration
                    thresholdOccurrences
                  }
                }
                nextCursor
              }
            }
          }
        }
      }
      `;

      const response = await fetch("https://api.newrelic.com/graphql", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "API-Key": NEW_RELIC_API_KEY,
        },
        body: JSON.stringify({ query }),
      });

      const data = await response.json();
      const result = data?.data?.actor?.account?.alerts?.nrqlConditionsSearch;
      if (!result) break;

      allConditions = allConditions.concat(result.nrqlConditions);
      cursor = result.nextCursor;

    } while (cursor);

    res.json(allConditions);

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error al obtener alertas" });
  }
});

app.listen(PORT, () => console.log(`Servidor corriendo en http://localhost:${PORT}`));
