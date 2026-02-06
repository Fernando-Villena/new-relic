import fetch from "node-fetch";
import dotenv from "dotenv";
import fs from "fs";

dotenv.config();

const NEW_RELIC_API_KEY = process.env.NEW_RELIC_API_KEY;
const ACCOUNT_ID = process.env.ACCOUNT_ID;

let logOutput = "";
function log(msg) {
    console.log(msg);
    logOutput += msg + "\n";
}

async function graphqlQuery(query) {
    const resp = await fetch("https://api.newrelic.com/graphql", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "API-Key": NEW_RELIC_API_KEY,
        },
        body: JSON.stringify({ query }),
    });
    return await resp.json();
}

function extractGuidsFromNrql(nrqlQuery) {
    if (!nrqlQuery) return [];
    const regex = /(?:entity\.?guid|guid|entityGuid)\s*(?:IN\s*\(|=)\s*['"]([^'"]+)['"]/gi;
    const matches = [];
    let match;
    while ((match = regex.exec(nrqlQuery)) !== null) {
        matches.push(match[1]);
    }
    return matches;
}

async function debugEntity(name) {
    log(`Searching for entity: ${name}`);
    const q = `{
    actor {
      entitySearch(query: "name = '${name}'") {
        results {
          entities {
            guid
            name
            type
            domain
          }
        }
      }
    }
  }`;
    const data = await graphqlQuery(q);
    const entities = data?.data?.actor?.entitySearch?.results?.entities || [];
    log("Entities found: " + JSON.stringify(entities, null, 2));

    if (entities.length > 0) {
        const ent = entities[0];
        const guid = ent.guid;
        log(`\nSearching for all alerts to test matching for: ${name} (${guid})`);

        let allConditions = [];
        let cursor = null;
        do {
            const alertQ = `{
        actor {
          account(id: ${ACCOUNT_ID}) {
            alerts {
              nrqlConditionsSearch(cursor: ${cursor ? `"${cursor}"` : null}) {
                nrqlConditions {
                  id
                  name
                  nrql { query }
                  entity { guid name }
                }
                nextCursor
              }
            }
          }
        }
      }`;
            const alertData = await graphqlQuery(alertQ);
            const result = alertData?.data?.actor?.account?.alerts?.nrqlConditionsSearch;
            if (!result) break;
            allConditions = allConditions.concat(result.nrqlConditions);
            cursor = result.nextCursor;
        } while (cursor);

        log(`Total conditions fetched: ${allConditions.length}`);

        const matched = allConditions.filter(cond => {
            const guids = extractGuidsFromNrql(cond.nrql?.query);
            const hasGuidMatch = guids.includes(guid) || (cond.entity && cond.entity.guid === guid);

            const query = (cond.nrql?.query || "").toLowerCase();
            const condName = (cond.name || "").toLowerCase();
            const entName = name.toLowerCase();
            const hasNameMatch = query.includes(entName) || condName.includes(entName);

            if (hasGuidMatch) log(`[GUID match] ${cond.name}`);
            if (hasNameMatch && !hasGuidMatch) log(`[NAME match] ${cond.name}`);

            return hasGuidMatch || hasNameMatch;
        });

        log(`\nFound ${matched.length} matched alert conditions.`);
    }

    fs.writeFileSync("debug_output_log.txt", logOutput);
}

debugEntity("appwvcms01");
