#!/usr/bin/env npx ts-node

import { glob } from "glob"
import * as fs from "fs"
import * as path from "path"

import { schema } from "@uniswap/token-lists"
import Ajv from "ajv"
import addFormats from "ajv-formats"

import fleekStorage from "@fleekhq/fleek-storage-js"

// Check if version increment is requested
const shouldIncrementVersion = process.argv.includes('--increment-version')

const ajv = new Ajv({ allErrors: true, verbose: true })
addFormats(ajv)
const tokenlistValidator = ajv.compile(schema)

// sysexits(3) error codes
const EX_OK = 0
const EX_USAGE = 64
const EX_DATAERR = 65
const EX_NOINPUT = 66

declare global {
  namespace NodeJS {
    interface ProcessEnv {
      FLEEK_STORAGE_API_KEY?: string
      FLEEK_STORAGE_API_SECRET?: string
    }
  }
}

// parse and validate all JSON in chains/*.json
glob("chains/*.json", {}, async function (er, files) {
  // validate that the chain ID of each token matches the file name
  for (const f of files) {
    if (!f.match(/\d+\.json/)) {
      process.stderr.write(`Invalid token filename - ${f}`)
      process.exit(EX_DATAERR)
    }
  }

  // numeric sort
  const sorted: string[] = files.sort((f1, f2) => {
    const n1 = parseInt(f1.match(/chains\/(\d+)\.json$/)[1])
    const n2 = parseInt(f2.match(/chains\/(\d+)\.json$/)[1])

    if (n1 > n2) {
      return 1
    }

    if (n1 < n2) {
      return -1
    }

    return 0
  })

  let tokens: any[] = []

  // for each file, parse as JSON and validate tokens
  for (const f of sorted) {
    const chainId = parseInt(f.match(/chains\/(\d+)\.json$/)[1])

    const data = fs.readFileSync(path.resolve(__dirname, "./../", f))
    let parsed
    try {
      parsed = JSON.parse(data.toString())
    } catch (e) {
      process.stderr.write(`Invalid token file - ${f}`)
      process.exit(EX_DATAERR)
    }
    // validate that the chain ID of each token matches the file name
    for (const token of parsed) {
      if(!("address" in token)) {
        process.stderr.write(`Invalid token in file, no address - ${f} - ${token}`)
        process.exit(EX_DATAERR)
      }

      tokens.push({
        ...token,
        chainId
      })
    }
  }

  // if we can, upload all token images to IPFS and use that for the logoURIs
  if(process.env.FLEEK_STORAGE_API_KEY && process.env.FLEEK_STORAGE_API_SECRET) {
    process.stdout.write("Uploading token logos to IPFS...\n")
    tokens = await Promise.all(tokens.map(async (token) => {
      if (!token.logoURI) {
        return token
      }
      const localTokenPath = path.resolve(__dirname, "../chains", token["logoURI"])
      const uploadRequest = {
        apiKey: process.env.FLEEK_STORAGE_API_KEY,
        apiSecret: process.env.FLEEK_STORAGE_API_SECRET,
        key: `tokens/${token["chainId"]}/${token["address"]}`,
        data: fs.readFileSync(localTokenPath),
      }
      const result = await fleekStorage.upload(uploadRequest)

      process.stdout.write(`Uploaded ${ token.symbol } to ${ result.hash }\n`)

      return {
        ...token,
        logoURI: `ipfs://${result["hash"]}`
      }
    }))
  } else {
    // otherwise, use GitHub raw URLs
    process.stdout.write("No Fleek credentials found, using GitHub URLs rather than IPFS...\n")
    tokens = tokens.map((token) => ({
      ...token,
      logoURI: token.logoURI ? token["logoURI"].replace(
        /^\.\./,
        "https://github.com/tallycash/token-list/raw/main"
      ) : undefined
    }))
  }

  const tokenlistTemplate = JSON.parse(fs.readFileSync(path.resolve(__dirname, "./../", "base.tokenlist.json")).toString())
  
  // Handle version increment if requested
  let updatedTemplate = tokenlistTemplate
  if (shouldIncrementVersion) {
    // Increment minor version
    const newVersion = {
      ...tokenlistTemplate.version,
      minor: tokenlistTemplate.version.minor + 1,
      patch: 0 // Reset patch version when incrementing minor
    }
    
    // Update timestamp to current time
    const currentTimestamp = new Date().toISOString()
    
    updatedTemplate = {
      ...tokenlistTemplate,
      version: newVersion,
      timestamp: currentTimestamp
    }
    
    // Write updated template back to base.tokenlist.json
    fs.writeFileSync(
      path.resolve(__dirname, "./../", "base.tokenlist.json"), 
      JSON.stringify(updatedTemplate, undefined, 2) + '\n'
    )
    
    // Also update package.json version to match
    const packageJsonPath = path.resolve(__dirname, "./../", "package.json")
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath).toString())
    packageJson.version = `${newVersion.major}.${newVersion.minor}.${newVersion.patch}`
    fs.writeFileSync(packageJsonPath, JSON.stringify(packageJson, undefined, 2) + '\n')
    
    process.stdout.write(`Version incremented to ${packageJson.version}\n`)
  }

  fs.mkdirSync(path.resolve(__dirname, "../build/"), { recursive: true })

  const outputFilename = path.resolve(__dirname, "../build/", "tallycash.tokenlist.json")

  const newTokenList = {
    ...updatedTemplate,
    tokens
  }

  const valid = tokenlistValidator(newTokenList)

  if (!valid) {
    process.stderr.write("Invalid token list, errors below:\n")
    for (const e of tokenlistValidator.errors) {
      process.stderr.write(`${JSON.stringify(e, undefined, 2)}\n`)
    }
    process.exit(EX_DATAERR)
  }

  fs.writeFileSync(outputFilename, JSON.stringify(newTokenList, undefined, 2))

  // if we can, upload token list to IPFS
  if(process.env.FLEEK_STORAGE_API_KEY && process.env.FLEEK_STORAGE_API_SECRET) {
    process.stdout.write("Uploading token list to IPFS...\n")
    const uploadRequest = {
      apiKey: process.env.FLEEK_STORAGE_API_KEY,
      apiSecret: process.env.FLEEK_STORAGE_API_SECRET,
      key: `tallycash.tokenlist.json`,
      data: fs.readFileSync(outputFilename),
    }
    const result = await fleekStorage.upload(uploadRequest)

    process.stdout.write(`Uploaded list to ${ result.hash }\n`)
  }
})
