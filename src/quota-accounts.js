"use strict";

const { loadSettings } = require("./settings");
const { resolveKimiHome } = require("./paths");
const { resolveQuotaAccount } = require("./quota-tool");

function listKimiQuotaAccounts(cliHome, settings = loadSettings()) {
  const configured = (settings.quotaAccounts || []).filter((account) => account.tool === "kimi-code");
  if (configured.length) return configured.map((account) => ({ ...account }));
  return [{ tool: "kimi-code", accountKey: "kimi:default", label: "Default", home: resolveKimiHome(cliHome) }];
}

function listToolQuotaAccounts({ tool, cliHome }) {
  return tool === "kimi-code" ? listKimiQuotaAccounts(cliHome) : [];
}

function resolveKimiQuotaAccount(cliHome, accountKey, settings) {
  const accounts = listKimiQuotaAccounts(cliHome, settings);
  const resolved = resolveQuotaAccount({ accountKey, accounts: accounts.map((account) => account.accountKey) });
  return accounts.find((account) => account.accountKey === resolved);
}

module.exports = { listKimiQuotaAccounts, listToolQuotaAccounts, resolveKimiQuotaAccount };
