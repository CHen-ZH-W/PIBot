const { mkdir, readdir, readFile, writeFile } = require("node:fs/promises");
const path = require("node:path");

async function main() {
  const storeRoot = path.resolve(process.argv[2] || ".pibot");
  const tickets = await readTickets(path.join(storeRoot, "evolution", "tickets.json"));
  if (tickets.length === 0) {
    console.log("No evolution tickets found.");
    return;
  }

  const webuiDir = path.join(storeRoot, "channels", "webui");
  const evolutionDir = path.join(webuiDir, "self-evaluation");
  const globalContextPath = path.join(evolutionDir, "context.jsonl");
  const globalRecords = await readJsonl(globalContextPath);
  const ticketRecords = splitRecordsByTicket(globalRecords, tickets);

  const siblingRecords = await readOldSiblingTicketRecords(webuiDir, tickets);
  for (const [ticketId, records] of siblingRecords) {
    appendGroupedRecords(ticketRecords, ticketId, records);
  }

  await mkdir(evolutionDir, { recursive: true });
  if (globalRecords.length > 0) {
    const backupPath = path.join(
      evolutionDir,
      `context.before-ticket-migration.${timestamp()}.jsonl`,
    );
    await writeFile(
      backupPath,
      globalRecords.map((entry) => entry.line).join("\n") + "\n",
      "utf8",
    );
    console.log(`Backed up global context to ${relative(backupPath)}`);
  }

  let migratedRecords = 0;
  for (const ticket of tickets) {
    const records = ticketRecords.get(ticket.id) || [];
    if (records.length === 0) {
      continue;
    }
    const filePath = ticketContextPath(evolutionDir, ticket.id);
    const written = await mergeJsonl(filePath, records);
    migratedRecords += written;
    console.log(`Migrated ${written} records to ${relative(filePath)}`);
  }

  const unassigned = ticketRecords.get("") || [];
  const globalIndexRecords = [
    ...tickets.map(topicRecordForTicket),
    ...unassigned.map((entry) => entry.record),
  ];
  await writeFile(
    globalContextPath,
    globalIndexRecords.map((record) => JSON.stringify(record)).join("\n") + "\n",
    "utf8",
  );

  console.log(
    `Rebuilt ${relative(globalContextPath)} with ${tickets.length} topics and ${unassigned.length} unassigned records.`,
  );
  console.log(`Migration complete. New ticket records written: ${migratedRecords}.`);
}

async function readTickets(filePath) {
  try {
    const parsed = JSON.parse(await readFile(filePath, "utf8"));
    return Array.isArray(parsed.tickets) ? parsed.tickets : [];
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function readJsonl(filePath) {
  let text;
  try {
    text = await readFile(filePath, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const records = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    try {
      records.push({
        line: trimmed,
        record: JSON.parse(trimmed),
      });
    } catch {
      records.push({
        line: trimmed,
        record: {
          type: "context_message",
          schemaVersion: 1,
          role: "assistant",
          content: `Unparsed legacy context line: ${trimmed}`,
          source: "agent",
          createdAt: new Date().toISOString(),
        },
      });
    }
  }
  return records;
}

function splitRecordsByTicket(records, tickets) {
  const grouped = new Map();
  const ticketIds = tickets.map((ticket) => ticket.id);
  let currentTicketId = "";

  for (const entry of records) {
    const mentioned = ticketIds.filter((ticketId) =>
      JSON.stringify(entry.record).includes(ticketId)
    );
    if (mentioned.length === 1) {
      currentTicketId = mentioned[0];
    } else if (mentioned.length > 1 && !mentioned.includes(currentTicketId)) {
      currentTicketId = mentioned[0];
    }
    appendGroupedRecords(grouped, currentTicketId, [entry]);
  }

  return grouped;
}

async function readOldSiblingTicketRecords(webuiDir, tickets) {
  const grouped = new Map();
  let entries;
  try {
    entries = await readdir(webuiDir, { withFileTypes: true });
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return grouped;
    }
    throw error;
  }

  const knownTicketIds = new Set(tickets.map((ticket) => ticket.id));
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith("self-evaluation--")) {
      continue;
    }
    const ticketId = entry.name.slice("self-evaluation--".length);
    if (!knownTicketIds.has(ticketId)) {
      continue;
    }
    appendGroupedRecords(
      grouped,
      ticketId,
      await readJsonl(path.join(webuiDir, entry.name, "context.jsonl")),
    );
  }
  return grouped;
}

function appendGroupedRecords(grouped, ticketId, records) {
  if (records.length === 0) {
    return;
  }
  const existing = grouped.get(ticketId) || [];
  grouped.set(ticketId, [...existing, ...records]);
}

async function mergeJsonl(filePath, records) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const existing = await readJsonl(filePath);
  const seen = new Set(existing.map((entry) => JSON.stringify(entry.record)));
  const next = existing.map((entry) => entry.record);
  let written = 0;
  for (const entry of records) {
    const serialized = JSON.stringify(entry.record);
    if (seen.has(serialized)) {
      continue;
    }
    seen.add(serialized);
    next.push(entry.record);
    written += 1;
  }
  await writeFile(
    filePath,
    next.map((record) => JSON.stringify(record)).join("\n") + "\n",
    "utf8",
  );
  return written;
}

function ticketContextPath(evolutionDir, ticketId) {
  return path.join(evolutionDir, "tickets", ticketId, "context.jsonl");
}

function topicRecordForTicket(ticket) {
  const topic = ticket.proposal && ticket.proposal.completionTopic
    ? ticket.proposal.completionTopic
    : ticket.proposal && ticket.proposal.versionTopic
    ? ticket.proposal.versionTopic
    : ticket.title;
  return {
    type: "context_message",
    schemaVersion: 1,
    role: "assistant",
    content: [
      `Evolution topic: ${topic}`,
      `Ticket: ${ticket.id}`,
      `Status: ${ticket.status}`,
      `Target: ${ticket.target}`,
      `Updated: ${ticket.updatedAt}`,
    ].join("\n"),
    source: "agent",
    createdAt: ticket.updatedAt || ticket.createdAt || new Date().toISOString(),
  };
}

function timestamp() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/u, "Z");
}

function relative(filePath) {
  return path.relative(process.cwd(), filePath) || ".";
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
