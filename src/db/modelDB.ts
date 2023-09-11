import { DBSchema, IDBPDatabase, openDB } from "idb/with-async-ittr";
import { v4 as uuidv4 } from "uuid";
import { DBModel, DBTokenizer } from "./types";
import { AvailableModels } from "../models";
import { Result } from "true-myth";
import pRetry from "p-retry";

interface ModelDBSchema extends DBSchema {
    models: {
        value: DBModel;
        key: string;
        indexes: { modelID: string };
    };
    availableModels: {
        value: string;
        key: AvailableModels;
    };
    tokenizer: {
        value: DBTokenizer;
        key: string;
        indexes: { modelID: string };
    };
}

/**
 * A class that represents a database of models and related data.
 *
 * @remarks
 * The `ModelDB` class uses the IndexedDB API to store and retrieve data. The database schema is defined by the `ModelDBSchema` interface.
 *
 * To use the `ModelDB` class, first create an instance by calling the constructor. Then call the `init` method to open the database.
 *
 * Example usage:
 *
 * ```typescript
 * ```
 */
export default class ModelDB {
    private readonly remoteUrl = "https://rmbl.us";
    private db: IDBPDatabase<ModelDBSchema> | null;

    private constructor(db: IDBPDatabase<ModelDBSchema>) {
        this.db = db;
    }

    public static async create(): Promise<ModelDB> {
        const db = await openDB<ModelDBSchema>("models", 1, {
            upgrade(db) {
                const modelStore = db.createObjectStore("models");
                modelStore.createIndex("modelID", "modelID");
                db.createObjectStore("availableModels");
                const tokenizerStore = db.createObjectStore("tokenizer");
                tokenizerStore.createIndex("modelID", "modelID");
            },
        });

        return new ModelDB(db);
    }

    private async fetchBytes(
        url: string,
        onProgress?: (progress: number) => void
    ): Promise<Result<Uint8Array, Error>> {
        try {
            const response = await fetch(url);
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            const reader = response.body!.getReader();
            const contentLength = response.headers.get("Content-Length");
            if (!contentLength) {
                throw new Error("Content-Length header not found");
            }
            const parsedLength = parseInt(contentLength, 10);

            let receivedLength = 0;

            const chunks: Uint8Array[] = [];
            for (;;) {
                const { done, value } = await reader.read();

                if (done) {
                    break;
                }

                chunks.push(value);
                receivedLength += value.length;
                const progress = (receivedLength / parsedLength) * 100;

                if (onProgress) {
                    onProgress(progress);
                }
            }

            const chunksAll = new Uint8Array(receivedLength);
            let position = 0;
            for (const chunk of chunks) {
                chunksAll.set(chunk, position);
                position += chunk.length;
            }

            return Result.ok(chunksAll); // return all chunks as Uint8Array
        } catch (error) {
            console.error("Fetch Error: ", error);
            return Result.err(new Error("Fetch Error"));
        }
    }

    async _getModel(modelID: string): Promise<Result<DBModel, Error>> {
        if (!this.db) {
            return Result.err(new Error("ModelDB not initialized"));
        }

        const tx = this.db.transaction("models", "readonly");
        const store = tx.objectStore("models");
        const model = await store.get(modelID);

        if (!model) {
            return Result.err(new Error("Model not found"));
        }
        return Result.ok(model);
    }

    async getTokenizer(modelID: string): Promise<Result<DBTokenizer, Error>> {
        if (!this.db) {
            return Result.err(new Error("ModelDB not initialized"));
        }

        let tokenizer = await this.db.getFromIndex(
            "tokenizer",
            "modelID",
            modelID
        );

        if (!tokenizer) {
            const tokenizerBytes = await this.fetchBytes(
                "https://huggingface.co/openai/whisper-large-v2/raw/main/tokenizer.json"
            );
            if (tokenizerBytes.isErr) {
                return Result.err(tokenizerBytes.error);
            }
            const tokenizerBytesValue = tokenizerBytes.value;
            tokenizer = {
                modelID,
                bytes: tokenizerBytesValue,
            };
            this.db.put("tokenizer", tokenizer, modelID);
            tokenizer = await this.db.getFromIndex(
                "tokenizer",
                "modelID",
                modelID
            );
        }

        return Result.ok(tokenizer!);
    }

    async getModel(
        model: AvailableModels,
        onProgress: (progress: number) => void
    ): Promise<Result<DBModel, Error>> {
        if (!this.db) {
            return Result.err(new Error("ModelDB not initialized"));
        }
        let modelID = await this.db.get("availableModels", model);
        if (!modelID) {
            await this.fetchRemote(model, onProgress);
            modelID = await this.db.get("availableModels", model);
        }
        return await this._getModel(modelID!);
    }

    async fetchRemote(
        model: AvailableModels,
        onProgress: (progress: number) => void
    ): Promise<Result<void, Error>> {
        const remoteURL = `${this.remoteUrl}/whisper-turbo/${model}-pf16-full.bin`;
        const fetchResult = await this.fetchBytes(remoteURL, onProgress);

        if (fetchResult.isErr) {
            return Result.err(fetchResult.error);
        }
        const data = fetchResult.value;

        const modelID = uuidv4();
        this.db!.put("availableModels", modelID, model);
        const dbModel = { name: model, ID: modelID, bytes: data };
        this.db!.put("models", dbModel, modelID);
        this.getTokenizer(modelID);

        return Result.ok(undefined);
    }
}