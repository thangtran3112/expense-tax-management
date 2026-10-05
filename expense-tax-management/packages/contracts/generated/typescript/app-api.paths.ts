export interface paths {
    "/api/v1/business-industries": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Default Response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            items: {
                                code: string;
                                name: string;
                                /** @enum {string} */
                                status: "active" | "inactive";
                            }[];
                        };
                    };
                };
                /** @description Default Response */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                500: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/file-content/{fileId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: {
            parameters: {
                query: {
                    expires: string;
                    signature: string;
                };
                header?: never;
                path: {
                    fileId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Default Response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        put: {
            parameters: {
                query: {
                    expires: string;
                    signature: string;
                };
                header?: never;
                path: {
                    fileId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Default Response */
                204: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Default Response */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                410: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                413: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                500: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
            };
        };
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/integrations/clerk/webhook": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header: {
                    "svix-id": string;
                    "svix-signature": string;
                    "svix-timestamp": string;
                };
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Default Response */
                202: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {boolean} */
                            accepted: true;
                            replayed: boolean;
                        };
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/invitations/accept": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        token: string;
                    };
                };
            };
            responses: {
                /** @description Default Response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            acceptedAt: string | null;
                            acceptedByUserId: string | null;
                            /** Format: date-time */
                            createdAt: string;
                            /** Format: uuid */
                            createdByUserId: string;
                            /** Format: email */
                            email: string;
                            /** Format: date-time */
                            expiresAt: string;
                            grant: {
                                /** @enum {string} */
                                type: "none";
                            } | {
                                /** Format: uuid */
                                profileId: string;
                                /** @enum {string} */
                                role: "owner" | "editor" | "viewer";
                                /** @enum {string} */
                                type: "personal";
                            } | {
                                /** Format: uuid */
                                businessId: string;
                                /** @enum {string} */
                                role: "owner" | "editor" | "viewer";
                                /** @enum {string} */
                                type: "business";
                            };
                            /** Format: uuid */
                            id: string;
                            revokedAt: string | null;
                            /** Format: uuid */
                            tenantId: string;
                            /** @enum {string} */
                            tenantRole: "owner" | "admin" | "member";
                        };
                    };
                };
                /** @description Default Response */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                500: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/plans": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Default Response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            items: {
                                currentVersion: {
                                    /** Format: date-time */
                                    createdAt: string;
                                    /** Format: date-time */
                                    effectiveAt: string;
                                    entitlements: {
                                        /** @enum {string} */
                                        featureKey: "receipt_forwarding" | "connected_mailbox_scan" | "ai_search" | "ocr_mode_fast" | "ocr_mode_balanced" | "ocr_mode_accurate";
                                        isEnabled: boolean;
                                        limitPeriod: ("monthly" | "unlimited") | null;
                                        limitValue: number | null;
                                    }[];
                                    /** Format: uuid */
                                    id: string;
                                    isCurrent: boolean;
                                    /** Format: uuid */
                                    planId: string;
                                    versionNumber: number;
                                };
                                description: string | null;
                                /** Format: uuid */
                                id: string;
                                key: string;
                                name: string;
                            }[];
                        };
                    };
                };
                /** @description Default Response */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                500: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/taxonomies": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Default Response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            items: {
                                code: string;
                                /** Format: date-time */
                                createdAt: string;
                                /** Format: uuid */
                                id: string;
                                /** @enum {string} */
                                jurisdictionCode: "US-FEDERAL";
                                name: string;
                                sourceChecksum: string;
                                sourceRevision: string;
                                /** Format: uri */
                                sourceUrl: string;
                                /** @enum {string} */
                                status: "active" | "superseded";
                                taxYear: number;
                            }[];
                        };
                    };
                };
                /** @description Default Response */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                500: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/taxonomies/{taxonomyVersionId}/categories": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    taxonomyVersionId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Default Response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            items: {
                                code: string;
                                description: string | null;
                                /** Format: uuid */
                                id: string;
                                name: string;
                                officialForm: string | null;
                                officialLine: string | null;
                                sortOrder: number;
                                /** @enum {string} */
                                status: "active" | "inactive";
                                /** Format: uuid */
                                taxonomyVersionId: string;
                            }[];
                        };
                    };
                };
                /** @description Default Response */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                500: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/tenants": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Default Response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            items: {
                                /** Format: date-time */
                                createdAt: string;
                                /** Format: uuid */
                                id: string;
                                name: string;
                                slug: string;
                                /** @enum {string} */
                                status: "active" | "archived";
                                /** Format: date-time */
                                updatedAt: string;
                                version: number;
                            }[];
                        };
                    };
                };
                /** @description Default Response */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                500: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
            };
        };
        put?: never;
        post: {
            parameters: {
                query?: never;
                header: {
                    "idempotency-key": string;
                };
                path?: never;
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        name: string;
                    };
                };
            };
            responses: {
                /** @description Default Response */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            personalMembership: {
                                /** Format: date-time */
                                createdAt: string;
                                /** Format: uuid */
                                personalProfileId: string;
                                /** @enum {string} */
                                role: "owner" | "editor" | "viewer";
                                /** @enum {string} */
                                status: "active" | "inactive";
                                /** Format: uuid */
                                tenantId: string;
                                /** Format: date-time */
                                updatedAt: string;
                                /** Format: uuid */
                                userId: string;
                                version: number;
                            };
                            personalProfile: {
                                /** Format: date-time */
                                createdAt: string;
                                /** Format: uuid */
                                id: string;
                                name: string;
                                /** Format: uuid */
                                tenantId: string;
                                /** Format: date-time */
                                updatedAt: string;
                                version: number;
                            };
                            tenant: {
                                /** Format: date-time */
                                createdAt: string;
                                /** Format: uuid */
                                id: string;
                                name: string;
                                slug: string;
                                /** @enum {string} */
                                status: "active" | "archived";
                                /** Format: date-time */
                                updatedAt: string;
                                version: number;
                            };
                            tenantMembership: {
                                /** Format: date-time */
                                createdAt: string;
                                /** @enum {string} */
                                role: "owner" | "admin" | "member";
                                /** @enum {string} */
                                status: "active" | "inactive";
                                /** Format: uuid */
                                tenantId: string;
                                /** Format: date-time */
                                updatedAt: string;
                                /** Format: uuid */
                                userId: string;
                                version: number;
                            };
                        };
                    };
                };
                /** @description Default Response */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                500: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/tenants/{tenantId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    tenantId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Default Response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** Format: date-time */
                            createdAt: string;
                            /** Format: uuid */
                            id: string;
                            name: string;
                            slug: string;
                            /** @enum {string} */
                            status: "active" | "archived";
                            /** Format: date-time */
                            updatedAt: string;
                            version: number;
                        };
                    };
                };
                /** @description Default Response */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                500: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    tenantId: string;
                };
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        expectedVersion: number;
                        name: string;
                    };
                };
            };
            responses: {
                /** @description Default Response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** Format: date-time */
                            createdAt: string;
                            /** Format: uuid */
                            id: string;
                            name: string;
                            slug: string;
                            /** @enum {string} */
                            status: "active" | "archived";
                            /** Format: date-time */
                            updatedAt: string;
                            version: number;
                        };
                    };
                };
                /** @description Default Response */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                500: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
            };
        };
        trace?: never;
    };
    "/api/v1/tenants/{tenantId}/addons": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    tenantId: string;
                };
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        /** @enum {string} */
                        featureKey: "receipt_forwarding" | "connected_mailbox_scan" | "ai_search" | "ocr_mode_fast" | "ocr_mode_balanced" | "ocr_mode_accurate";
                        reason: string;
                    };
                };
            };
            responses: {
                /** @description Default Response */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** Format: date-time */
                            createdAt: string;
                            enabled: boolean;
                            expiresAt: string | null;
                            /** @enum {string} */
                            featureKey: "receipt_forwarding" | "connected_mailbox_scan" | "ai_search" | "ocr_mode_fast" | "ocr_mode_balanced" | "ocr_mode_accurate";
                            grantedBy: string;
                            /** Format: uuid */
                            id: string;
                            /** Format: uuid */
                            tenantId: string;
                        };
                    };
                };
                /** @description Default Response */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                500: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/tenants/{tenantId}/addons/{featureKey}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        delete: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    featureKey: "receipt_forwarding" | "connected_mailbox_scan" | "ai_search" | "ocr_mode_fast" | "ocr_mode_balanced" | "ocr_mode_accurate";
                    tenantId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Default Response */
                204: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Default Response */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                500: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
            };
        };
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/tenants/{tenantId}/businesses": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    tenantId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Default Response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            items: {
                                baseCurrency: string;
                                /** Format: date-time */
                                createdAt: string;
                                /** Format: uuid */
                                id: string;
                                industryCode: string;
                                name: string;
                                /** @enum {string} */
                                status: "active" | "archived";
                                /** Format: uuid */
                                tenantId: string;
                                timezone: string;
                                /** Format: date-time */
                                updatedAt: string;
                                version: number;
                            }[];
                        };
                    };
                };
                /** @description Default Response */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                500: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
            };
        };
        put?: never;
        post: {
            parameters: {
                query?: never;
                header: {
                    "idempotency-key": string;
                };
                path: {
                    tenantId: string;
                };
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        baseCurrency: string;
                        industryCode: string;
                        name: string;
                        timezone: string;
                    };
                };
            };
            responses: {
                /** @description Default Response */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            business: {
                                baseCurrency: string;
                                /** Format: date-time */
                                createdAt: string;
                                /** Format: uuid */
                                id: string;
                                industryCode: string;
                                name: string;
                                /** @enum {string} */
                                status: "active" | "archived";
                                /** Format: uuid */
                                tenantId: string;
                                timezone: string;
                                /** Format: date-time */
                                updatedAt: string;
                                version: number;
                            };
                            businessMembership: {
                                /** Format: uuid */
                                businessId: string;
                                /** Format: date-time */
                                createdAt: string;
                                /** @enum {string} */
                                role: "owner" | "editor" | "viewer";
                                /** @enum {string} */
                                status: "active" | "inactive";
                                /** Format: uuid */
                                tenantId: string;
                                /** Format: date-time */
                                updatedAt: string;
                                /** Format: uuid */
                                userId: string;
                                version: number;
                            };
                            createdSpendingCategories: {
                                color: string;
                                /** Format: date-time */
                                createdAt: string;
                                description: string | null;
                                icon: string;
                                /** Format: uuid */
                                id: string;
                                name: string;
                                /** @enum {string} */
                                status: "active" | "archived";
                                templateKey: string | null;
                                /** Format: uuid */
                                tenantId: string;
                                /** Format: date-time */
                                updatedAt: string;
                                version: number;
                            }[];
                        };
                    };
                };
                /** @description Default Response */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                500: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/tenants/{tenantId}/businesses/{businessId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    businessId: string;
                    tenantId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Default Response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            baseCurrency: string;
                            /** Format: date-time */
                            createdAt: string;
                            /** Format: uuid */
                            id: string;
                            industryCode: string;
                            name: string;
                            /** @enum {string} */
                            status: "active" | "archived";
                            /** Format: uuid */
                            tenantId: string;
                            timezone: string;
                            /** Format: date-time */
                            updatedAt: string;
                            version: number;
                        };
                    };
                };
                /** @description Default Response */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                500: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    businessId: string;
                    tenantId: string;
                };
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        expectedVersion: number;
                    };
                };
            };
            responses: {
                /** @description Default Response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            baseCurrency: string;
                            /** Format: date-time */
                            createdAt: string;
                            /** Format: uuid */
                            id: string;
                            industryCode: string;
                            name: string;
                            /** @enum {string} */
                            status: "active" | "archived";
                            /** Format: uuid */
                            tenantId: string;
                            timezone: string;
                            /** Format: date-time */
                            updatedAt: string;
                            version: number;
                        };
                    };
                };
                /** @description Default Response */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                500: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
            };
        };
        options?: never;
        head?: never;
        patch: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    businessId: string;
                    tenantId: string;
                };
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        baseCurrency?: string;
                        expectedVersion: number;
                        industryCode?: string;
                        name?: string;
                        timezone?: string;
                    };
                };
            };
            responses: {
                /** @description Default Response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            baseCurrency: string;
                            /** Format: date-time */
                            createdAt: string;
                            /** Format: uuid */
                            id: string;
                            industryCode: string;
                            name: string;
                            /** @enum {string} */
                            status: "active" | "archived";
                            /** Format: uuid */
                            tenantId: string;
                            timezone: string;
                            /** Format: date-time */
                            updatedAt: string;
                            version: number;
                        };
                    };
                };
                /** @description Default Response */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                500: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
            };
        };
        trace?: never;
    };
    "/api/v1/tenants/{tenantId}/businesses/{businessId}/duplicate-matches": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: {
            parameters: {
                query?: {
                    cursor?: string;
                    limit?: number;
                    status?: "pending" | "merged" | "separate" | "dismissed";
                };
                header?: never;
                path: {
                    businessId: string;
                    tenantId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Default Response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            items: {
                                businessId: string | null;
                                /** Format: uuid */
                                candidateExpenseId: string;
                                confidence: number;
                                /** Format: date-time */
                                createdAt: string;
                                evidence: {
                                    amountDifferencePercent?: number;
                                    amountMinorUnits?: number;
                                    candidateAmountMinorUnits?: number;
                                    /** Format: date */
                                    candidateIncurredOn?: string;
                                    currency?: string;
                                    existingAmountMinorUnits?: number;
                                    /** Format: date */
                                    existingIncurredOn?: string;
                                    fileSha256?: string;
                                    fingerprintHash?: string;
                                    /** Format: date */
                                    incurredOn?: string;
                                    incurredOnDifferenceDays?: number;
                                    normalizedMerchant?: string;
                                };
                                /** Format: uuid */
                                existingExpenseId: string;
                                /** Format: uuid */
                                id: string;
                                idempotencyKey: string;
                                /** @enum {string} */
                                matchType: "file_sha256" | "fingerprint" | "fuzzy_fields";
                                personalProfileId: string | null;
                                resolutionIdempotencyKey: string | null;
                                resolvedAt: string | null;
                                resolvedBy: string | null;
                                /** @enum {string} */
                                status: "pending" | "merged" | "separate" | "dismissed";
                                /** Format: uuid */
                                tenantId: string;
                                version: number;
                            }[];
                            nextCursor: string | null;
                        };
                    };
                };
                /** @description Default Response */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                500: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/tenants/{tenantId}/businesses/{businessId}/duplicate-matches/{matchId}/resolve": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    businessId: string;
                    matchId: string;
                    tenantId: string;
                };
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        /** @enum {string} */
                        action: "merge" | "keep_both" | "discard_new";
                        expectedMatchVersion: number;
                        idempotencyKey: string;
                    };
                };
            };
            responses: {
                /** @description Default Response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {string} */
                            action: "merge" | "keep_both" | "discard_new";
                            idempotencyKey: string;
                            /** Format: uuid */
                            matchId: string;
                            /** @enum {string} */
                            status: "pending" | "merged" | "separate" | "dismissed";
                            version: number;
                        };
                    };
                };
                /** @description Default Response */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                500: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/tenants/{tenantId}/businesses/{businessId}/expenses": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: {
            parameters: {
                query?: {
                    amountMax?: string;
                    amountMin?: string;
                    cursor?: string;
                    direction?: "asc" | "desc";
                    incurredFrom?: string;
                    incurredTo?: string;
                    limit?: number;
                    projectId?: string;
                    sort?: "incurredOn" | "amount" | "merchant" | "createdAt";
                    spendingCategoryId?: string;
                    status?: "draft" | "ready" | "archived";
                    tagId?: string | string[];
                    taxReviewStatus?: "unreviewed" | "reviewed" | "excluded";
                };
                header?: never;
                path: {
                    businessId: string;
                    tenantId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Default Response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            items: {
                                amount: string;
                                businessId: string | null;
                                /** Format: date-time */
                                createdAt: string;
                                /** Format: uuid */
                                createdByUserId: string;
                                currency: string;
                                description: string | null;
                                /** Format: uuid */
                                id: string;
                                /** Format: date */
                                incurredOn: string;
                                mailboxProvenance: {
                                    /** Format: email */
                                    mailboxAccountEmail: string;
                                    pendingDuplicateReview: boolean;
                                    /** Format: date-time */
                                    receivedAt: string;
                                    /** Format: email */
                                    senderAddress: string;
                                } | null;
                                merchant: string;
                                personalProfileId: string | null;
                                projectId: string | null;
                                /** @enum {string} */
                                source: "manual" | "ocr" | "forwarded_email" | "connected_mailbox";
                                spendingCategoryId: string | null;
                                /** @enum {string} */
                                status: "draft" | "ready" | "archived";
                                /** @default [] */
                                tags: {
                                    color: string | null;
                                    /** Format: uuid */
                                    id: string;
                                    name: string;
                                }[];
                                taxYear: number;
                                /** Format: uuid */
                                tenantId: string;
                                /** Format: date-time */
                                updatedAt: string;
                                version: number;
                            }[];
                            nextCursor: string | null;
                        };
                    };
                };
                /** @description Default Response */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                500: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
            };
        };
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    businessId: string;
                    tenantId: string;
                };
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        amount: string;
                        businessId?: string | null;
                        currency: string;
                        description?: string | null;
                        /** Format: date */
                        incurredOn: string;
                        merchant: string;
                        personalProfileId?: string | null;
                        projectId?: string | null;
                        spendingCategoryId?: string | null;
                    };
                };
            };
            responses: {
                /** @description Default Response */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            amount: string;
                            businessId: string | null;
                            /** Format: date-time */
                            createdAt: string;
                            /** Format: uuid */
                            createdByUserId: string;
                            currency: string;
                            description: string | null;
                            /** Format: uuid */
                            id: string;
                            /** Format: date */
                            incurredOn: string;
                            mailboxProvenance: {
                                /** Format: email */
                                mailboxAccountEmail: string;
                                pendingDuplicateReview: boolean;
                                /** Format: date-time */
                                receivedAt: string;
                                /** Format: email */
                                senderAddress: string;
                            } | null;
                            merchant: string;
                            personalProfileId: string | null;
                            projectId: string | null;
                            /** @enum {string} */
                            source: "manual" | "ocr" | "forwarded_email" | "connected_mailbox";
                            spendingCategoryId: string | null;
                            /** @enum {string} */
                            status: "draft" | "ready" | "archived";
                            /** @default [] */
                            tags: {
                                color: string | null;
                                /** Format: uuid */
                                id: string;
                                name: string;
                            }[];
                            taxYear: number;
                            /** Format: uuid */
                            tenantId: string;
                            /** Format: date-time */
                            updatedAt: string;
                            version: number;
                        };
                    };
                };
                /** @description Default Response */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                500: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/tenants/{tenantId}/businesses/{businessId}/expenses/{expenseId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    businessId: string;
                    expenseId: string;
                    tenantId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Default Response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            amount: string;
                            businessId: string | null;
                            /** Format: date-time */
                            createdAt: string;
                            /** Format: uuid */
                            createdByUserId: string;
                            currency: string;
                            description: string | null;
                            /** Format: uuid */
                            id: string;
                            /** Format: date */
                            incurredOn: string;
                            mailboxProvenance: {
                                /** Format: email */
                                mailboxAccountEmail: string;
                                pendingDuplicateReview: boolean;
                                /** Format: date-time */
                                receivedAt: string;
                                /** Format: email */
                                senderAddress: string;
                            } | null;
                            merchant: string;
                            personalProfileId: string | null;
                            projectId: string | null;
                            /** @enum {string} */
                            source: "manual" | "ocr" | "forwarded_email" | "connected_mailbox";
                            spendingCategoryId: string | null;
                            /** @enum {string} */
                            status: "draft" | "ready" | "archived";
                            /** @default [] */
                            tags: {
                                color: string | null;
                                /** Format: uuid */
                                id: string;
                                name: string;
                            }[];
                            taxYear: number;
                            /** Format: uuid */
                            tenantId: string;
                            /** Format: date-time */
                            updatedAt: string;
                            version: number;
                        };
                    };
                };
                /** @description Default Response */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                500: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    businessId: string;
                    expenseId: string;
                    tenantId: string;
                };
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        expectedVersion: number;
                    };
                };
            };
            responses: {
                /** @description Default Response */
                204: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Default Response */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                500: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
            };
        };
        options?: never;
        head?: never;
        patch: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    businessId: string;
                    expenseId: string;
                    tenantId: string;
                };
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        amount?: string;
                        currency?: string;
                        description?: string | null;
                        expectedVersion: number;
                        /** Format: date */
                        incurredOn?: string;
                        merchant?: string;
                        projectId?: string | null;
                        spendingCategoryId?: string | null;
                        /** @enum {string} */
                        status?: "draft" | "ready";
                    };
                };
            };
            responses: {
                /** @description Default Response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            amount: string;
                            businessId: string | null;
                            /** Format: date-time */
                            createdAt: string;
                            /** Format: uuid */
                            createdByUserId: string;
                            currency: string;
                            description: string | null;
                            /** Format: uuid */
                            id: string;
                            /** Format: date */
                            incurredOn: string;
                            mailboxProvenance: {
                                /** Format: email */
                                mailboxAccountEmail: string;
                                pendingDuplicateReview: boolean;
                                /** Format: date-time */
                                receivedAt: string;
                                /** Format: email */
                                senderAddress: string;
                            } | null;
                            merchant: string;
                            personalProfileId: string | null;
                            projectId: string | null;
                            /** @enum {string} */
                            source: "manual" | "ocr" | "forwarded_email" | "connected_mailbox";
                            spendingCategoryId: string | null;
                            /** @enum {string} */
                            status: "draft" | "ready" | "archived";
                            /** @default [] */
                            tags: {
                                color: string | null;
                                /** Format: uuid */
                                id: string;
                                name: string;
                            }[];
                            taxYear: number;
                            /** Format: uuid */
                            tenantId: string;
                            /** Format: date-time */
                            updatedAt: string;
                            version: number;
                        };
                    };
                };
                /** @description Default Response */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                500: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
            };
        };
        trace?: never;
    };
    "/api/v1/tenants/{tenantId}/businesses/{businessId}/expenses/{expenseId}/enrichment-runs": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    businessId: string;
                    expenseId: string;
                    tenantId: string;
                };
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        /** Format: uuid */
                        expenseId: string;
                        kinds: ("tag" | "spending_category" | "tax_category")[];
                    };
                };
            };
            responses: {
                /** @description Default Response */
                204: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Default Response */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                412: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                500: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/tenants/{tenantId}/businesses/{businessId}/expenses/{expenseId}/suggestions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    businessId: string;
                    expenseId: string;
                    tenantId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Default Response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            items: ({
                                businessId: string | null;
                                businessTaxProfileId: null;
                                businessTaxProfileVersion: null;
                                confidence: number;
                                /** Format: date-time */
                                createdAt: string;
                                evidence: {
                                    [key: string]: string | number | boolean | null | (string | number | boolean | null)[];
                                };
                                evidenceHash: string;
                                /** Format: uuid */
                                expenseId: string;
                                expenseVersion: number;
                                /** Format: uuid */
                                id: string;
                                idempotencyKey: string;
                                /** Format: uuid */
                                jobId: string;
                                /** @enum {string} */
                                kind: "tag";
                                personalProfileId: string | null;
                                resolvedAt: string | null;
                                resolvedByUserId: string | null;
                                /** @enum {string} */
                                source: "historical" | "ai";
                                spendingCategoryId: null;
                                /** @enum {string} */
                                status: "pending" | "accepted" | "rejected" | "superseded";
                                /** Format: uuid */
                                tagId: string;
                                taxCategoryDefinitionId: null;
                                taxonomyVersionId: null;
                                taxYear: null;
                                /** Format: uuid */
                                tenantId: string;
                                version: number;
                            } | {
                                businessId: string | null;
                                businessTaxProfileId: null;
                                businessTaxProfileVersion: null;
                                confidence: number;
                                /** Format: date-time */
                                createdAt: string;
                                evidence: {
                                    [key: string]: string | number | boolean | null | (string | number | boolean | null)[];
                                };
                                evidenceHash: string;
                                /** Format: uuid */
                                expenseId: string;
                                expenseVersion: number;
                                /** Format: uuid */
                                id: string;
                                idempotencyKey: string;
                                /** Format: uuid */
                                jobId: string;
                                /** @enum {string} */
                                kind: "spending_category";
                                personalProfileId: string | null;
                                resolvedAt: string | null;
                                resolvedByUserId: string | null;
                                /** @enum {string} */
                                source: "historical" | "ai";
                                /** Format: uuid */
                                spendingCategoryId: string;
                                /** @enum {string} */
                                status: "pending" | "accepted" | "rejected" | "superseded";
                                tagId: null;
                                taxCategoryDefinitionId: null;
                                taxonomyVersionId: null;
                                taxYear: null;
                                /** Format: uuid */
                                tenantId: string;
                                version: number;
                            } | {
                                businessId: string | null;
                                /** Format: uuid */
                                businessTaxProfileId: string;
                                businessTaxProfileVersion: number;
                                confidence: number;
                                /** Format: date-time */
                                createdAt: string;
                                evidence: {
                                    [key: string]: string | number | boolean | null | (string | number | boolean | null)[];
                                };
                                evidenceHash: string;
                                /** Format: uuid */
                                expenseId: string;
                                expenseVersion: number;
                                /** Format: uuid */
                                id: string;
                                idempotencyKey: string;
                                /** Format: uuid */
                                jobId: string;
                                /** @enum {string} */
                                kind: "tax_category";
                                personalProfileId: string | null;
                                resolvedAt: string | null;
                                resolvedByUserId: string | null;
                                /** @enum {string} */
                                source: "historical" | "ai";
                                spendingCategoryId: null;
                                /** @enum {string} */
                                status: "pending" | "accepted" | "rejected" | "superseded";
                                tagId: null;
                                /** Format: uuid */
                                taxCategoryDefinitionId: string;
                                /** Format: uuid */
                                taxonomyVersionId: string;
                                taxYear: number;
                                /** Format: uuid */
                                tenantId: string;
                                version: number;
                            })[];
                            nextCursor: string | null;
                        };
                    };
                };
                /** @description Default Response */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                412: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                500: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/tenants/{tenantId}/businesses/{businessId}/expenses/{expenseId}/suggestions/{suggestionId}/resolve": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    businessId: string;
                    expenseId: string;
                    suggestionId: string;
                    tenantId: string;
                };
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        /** @enum {string} */
                        action: "accepted" | "rejected";
                        expectedExpenseVersion: number;
                        expectedSuggestionVersion: number;
                        idempotencyKey: string;
                        taxAcceptance?: {
                            /** Format: uuid */
                            businessTaxProfileId: string;
                            deductiblePercent: string;
                        };
                    };
                };
            };
            responses: {
                /** @description Default Response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {string} */
                            status: "pending" | "accepted" | "rejected" | "superseded";
                            /** Format: uuid */
                            suggestionId: string;
                            version: number;
                        };
                    };
                };
                /** @description Default Response */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                412: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                500: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/tenants/{tenantId}/businesses/{businessId}/expenses/{expenseId}/tags": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    businessId: string;
                    expenseId: string;
                    tenantId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Default Response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            items: {
                                appliedAt: string | null;
                                appliedByUserId: string | null;
                                businessId: string | null;
                                confidence: number;
                                /** Format: date-time */
                                createdAt: string;
                                /** Format: uuid */
                                expenseId: string;
                                /** Format: uuid */
                                id: string;
                                personalProfileId: string | null;
                                removedAt: string | null;
                                removedByUserId: string | null;
                                ruleVersion: number | null;
                                /** @enum {string} */
                                source: "manual" | "rule" | "historical" | "ai";
                                /** @enum {string} */
                                status: "active" | "removed";
                                suggestionId: string | null;
                                /** Format: uuid */
                                tagId: string;
                                /** Format: uuid */
                                tenantId: string;
                                version: number;
                            }[];
                            nextCursor: string | null;
                        };
                    };
                };
                /** @description Default Response */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                412: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                500: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/tenants/{tenantId}/businesses/{businessId}/expenses/{expenseId}/tags/{tagId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    businessId: string;
                    expenseId: string;
                    tagId: string;
                    tenantId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Default Response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            appliedAt: string | null;
                            appliedByUserId: string | null;
                            businessId: string | null;
                            confidence: number;
                            /** Format: date-time */
                            createdAt: string;
                            /** Format: uuid */
                            expenseId: string;
                            /** Format: uuid */
                            id: string;
                            personalProfileId: string | null;
                            removedAt: string | null;
                            removedByUserId: string | null;
                            ruleVersion: number | null;
                            /** @enum {string} */
                            source: "manual" | "rule" | "historical" | "ai";
                            /** @enum {string} */
                            status: "active" | "removed";
                            suggestionId: string | null;
                            /** Format: uuid */
                            tagId: string;
                            /** Format: uuid */
                            tenantId: string;
                            version: number;
                        };
                    };
                };
                /** @description Default Response */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                412: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                500: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
            };
        };
        post?: never;
        delete: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    businessId: string;
                    expenseId: string;
                    tagId: string;
                    tenantId: string;
                };
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        expectedVersion: number;
                    };
                };
            };
            responses: {
                /** @description Default Response */
                204: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Default Response */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                412: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                500: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
            };
        };
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/tenants/{tenantId}/businesses/{businessId}/expenses/{expenseId}/tax-treatment": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    businessId: string;
                    expenseId: string;
                    tenantId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Default Response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** Format: uuid */
                            businessId: string;
                            /** Format: uuid */
                            businessTaxProfileId: string;
                            /** Format: date-time */
                            createdAt: string;
                            /** Format: uuid */
                            createdByUserId: string;
                            deductiblePercent: string;
                            /** Format: uuid */
                            expenseId: string;
                            note: string | null;
                            /** @enum {string} */
                            reviewStatus: "unreviewed" | "reviewed" | "excluded";
                            /** Format: uuid */
                            taxCategoryDefinitionId: string;
                            /** Format: uuid */
                            taxonomyVersionId: string;
                            taxYear: number;
                            /** Format: uuid */
                            tenantId: string;
                            /** Format: date-time */
                            updatedAt: string;
                            /** Format: uuid */
                            updatedByUserId: string;
                            version: number;
                        };
                    };
                };
                /** @description Default Response */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                500: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
            };
        };
        put: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    businessId: string;
                    expenseId: string;
                    tenantId: string;
                };
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        /** Format: uuid */
                        businessTaxProfileId: string;
                        deductiblePercent: string;
                        note?: string | null;
                        /** @enum {string} */
                        reviewStatus: "unreviewed" | "reviewed" | "excluded";
                        /** Format: uuid */
                        taxCategoryDefinitionId: string;
                        /** Format: uuid */
                        taxonomyVersionId: string;
                    };
                };
            };
            responses: {
                /** @description Default Response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** Format: uuid */
                            businessId: string;
                            /** Format: uuid */
                            businessTaxProfileId: string;
                            /** Format: date-time */
                            createdAt: string;
                            /** Format: uuid */
                            createdByUserId: string;
                            deductiblePercent: string;
                            /** Format: uuid */
                            expenseId: string;
                            note: string | null;
                            /** @enum {string} */
                            reviewStatus: "unreviewed" | "reviewed" | "excluded";
                            /** Format: uuid */
                            taxCategoryDefinitionId: string;
                            /** Format: uuid */
                            taxonomyVersionId: string;
                            taxYear: number;
                            /** Format: uuid */
                            tenantId: string;
                            /** Format: date-time */
                            updatedAt: string;
                            /** Format: uuid */
                            updatedByUserId: string;
                            version: number;
                        };
                    };
                };
                /** @description Default Response */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                500: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
            };
        };
        post?: never;
        delete: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    businessId: string;
                    expenseId: string;
                    tenantId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Default Response */
                204: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Default Response */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                500: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
            };
        };
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/tenants/{tenantId}/businesses/{businessId}/exports": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: {
            parameters: {
                query?: {
                    cursor?: string;
                    limit?: number;
                };
                header?: never;
                path: {
                    businessId: string;
                    tenantId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Default Response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            items: {
                                /** Format: uuid */
                                businessId: string;
                                /** Format: date-time */
                                createdAt: string;
                                /** Format: uuid */
                                createdByUserId: string;
                                expenseCount: number;
                                files: {
                                    bytes: number;
                                    downloadUrl: string;
                                    path: string;
                                    sha256Hex: string;
                                    /** Format: date-time */
                                    urlExpiresAt: string;
                                }[];
                                filters: {
                                    includeUnresolved: boolean;
                                };
                                /** Format: uuid */
                                id: string;
                                manifest: {
                                    appVersion: string;
                                    baseCurrency: string;
                                    /** Format: uuid */
                                    bundleId: string;
                                    /** Format: uuid */
                                    businessId: string;
                                    counts: {
                                        excludedUnresolved: number;
                                        expenses: number;
                                        foreignExcluded: number;
                                        included: number;
                                    };
                                    /** Format: date-time */
                                    createdAt: string;
                                    files: {
                                        bytes: number;
                                        path: string;
                                        sha256Hex: string;
                                    }[];
                                    filters: {
                                        includeUnresolved: boolean;
                                    };
                                    foreignSummary: {
                                        currencies: string[];
                                        excludedCount: number;
                                    };
                                    profile: {
                                        /** Format: uuid */
                                        id: string;
                                        status: string;
                                    };
                                    review: {
                                        excluded: number;
                                        missingTreatment: number;
                                        reviewed: number;
                                        total: number;
                                        treated: number;
                                        unreviewed: number;
                                    };
                                    taxonomy: {
                                        code: string;
                                        name: string;
                                        /** Format: uuid */
                                        versionId: string;
                                    };
                                    taxYear: number;
                                    totals: {
                                        deductibleTotal: string;
                                        grossTotal: string;
                                    };
                                };
                                /** Format: uuid */
                                profileId: string;
                                profileStatus: string;
                                /** Format: uuid */
                                taxonomyVersionId: string;
                                taxYear: number;
                                /** Format: uuid */
                                tenantId: string;
                            }[];
                            nextCursor: string | null;
                        };
                    };
                };
                /** @description Default Response */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                500: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
            };
        };
        put?: never;
        post: {
            parameters: {
                query?: never;
                header: {
                    "idempotency-key": string;
                };
                path: {
                    businessId: string;
                    tenantId: string;
                };
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        includeUnresolved?: boolean;
                        taxYear: number;
                    };
                };
            };
            responses: {
                /** @description Default Response */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** Format: uuid */
                            businessId: string;
                            /** Format: date-time */
                            createdAt: string;
                            /** Format: uuid */
                            createdByUserId: string;
                            expenseCount: number;
                            files: {
                                bytes: number;
                                downloadUrl: string;
                                path: string;
                                sha256Hex: string;
                                /** Format: date-time */
                                urlExpiresAt: string;
                            }[];
                            filters: {
                                includeUnresolved: boolean;
                            };
                            /** Format: uuid */
                            id: string;
                            manifest: {
                                appVersion: string;
                                baseCurrency: string;
                                /** Format: uuid */
                                bundleId: string;
                                /** Format: uuid */
                                businessId: string;
                                counts: {
                                    excludedUnresolved: number;
                                    expenses: number;
                                    foreignExcluded: number;
                                    included: number;
                                };
                                /** Format: date-time */
                                createdAt: string;
                                files: {
                                    bytes: number;
                                    path: string;
                                    sha256Hex: string;
                                }[];
                                filters: {
                                    includeUnresolved: boolean;
                                };
                                foreignSummary: {
                                    currencies: string[];
                                    excludedCount: number;
                                };
                                profile: {
                                    /** Format: uuid */
                                    id: string;
                                    status: string;
                                };
                                review: {
                                    excluded: number;
                                    missingTreatment: number;
                                    reviewed: number;
                                    total: number;
                                    treated: number;
                                    unreviewed: number;
                                };
                                taxonomy: {
                                    code: string;
                                    name: string;
                                    /** Format: uuid */
                                    versionId: string;
                                };
                                taxYear: number;
                                totals: {
                                    deductibleTotal: string;
                                    grossTotal: string;
                                };
                            };
                            /** Format: uuid */
                            profileId: string;
                            profileStatus: string;
                            /** Format: uuid */
                            taxonomyVersionId: string;
                            taxYear: number;
                            /** Format: uuid */
                            tenantId: string;
                        };
                    };
                };
                /** @description Default Response */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                500: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/tenants/{tenantId}/businesses/{businessId}/exports/{exportId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    businessId: string;
                    exportId: string;
                    tenantId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Default Response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** Format: uuid */
                            businessId: string;
                            /** Format: date-time */
                            createdAt: string;
                            /** Format: uuid */
                            createdByUserId: string;
                            expenseCount: number;
                            files: {
                                bytes: number;
                                downloadUrl: string;
                                path: string;
                                sha256Hex: string;
                                /** Format: date-time */
                                urlExpiresAt: string;
                            }[];
                            filters: {
                                includeUnresolved: boolean;
                            };
                            /** Format: uuid */
                            id: string;
                            manifest: {
                                appVersion: string;
                                baseCurrency: string;
                                /** Format: uuid */
                                bundleId: string;
                                /** Format: uuid */
                                businessId: string;
                                counts: {
                                    excludedUnresolved: number;
                                    expenses: number;
                                    foreignExcluded: number;
                                    included: number;
                                };
                                /** Format: date-time */
                                createdAt: string;
                                files: {
                                    bytes: number;
                                    path: string;
                                    sha256Hex: string;
                                }[];
                                filters: {
                                    includeUnresolved: boolean;
                                };
                                foreignSummary: {
                                    currencies: string[];
                                    excludedCount: number;
                                };
                                profile: {
                                    /** Format: uuid */
                                    id: string;
                                    status: string;
                                };
                                review: {
                                    excluded: number;
                                    missingTreatment: number;
                                    reviewed: number;
                                    total: number;
                                    treated: number;
                                    unreviewed: number;
                                };
                                taxonomy: {
                                    code: string;
                                    name: string;
                                    /** Format: uuid */
                                    versionId: string;
                                };
                                taxYear: number;
                                totals: {
                                    deductibleTotal: string;
                                    grossTotal: string;
                                };
                            };
                            /** Format: uuid */
                            profileId: string;
                            profileStatus: string;
                            /** Format: uuid */
                            taxonomyVersionId: string;
                            taxYear: number;
                            /** Format: uuid */
                            tenantId: string;
                        };
                    };
                };
                /** @description Default Response */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                500: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/tenants/{tenantId}/businesses/{businessId}/files": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: {
            parameters: {
                query?: {
                    cursor?: string;
                    limit?: number;
                };
                header?: never;
                path: {
                    businessId: string;
                    tenantId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Default Response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            items: {
                                businessId: string | null;
                                /** @enum {string} */
                                contentType: "image/jpeg" | "image/png" | "image/webp" | "application/pdf";
                                /** Format: date-time */
                                createdAt: string;
                                expenseId: string | null;
                                /** Format: uuid */
                                id: string;
                                originalFilename: string;
                                personalProfileId: string | null;
                                sha256Hex: string | null;
                                sizeBytes: number | null;
                                /** @enum {string} */
                                status: "PENDING" | "READY" | "FAILED" | "DELETED";
                                storageKey: string;
                                /** Format: uuid */
                                tenantId: string;
                                /** @enum {string} */
                                thumbnailStatus: "pending" | "ready" | "skipped" | "failed";
                                thumbnailStorageKey: string | null;
                                /** Format: date-time */
                                updatedAt: string;
                                version: number;
                            }[];
                            nextCursor: string | null;
                        };
                    };
                };
                /** @description Default Response */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                410: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                413: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                500: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/tenants/{tenantId}/businesses/{businessId}/files/{fileId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    businessId: string;
                    fileId: string;
                    tenantId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Default Response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            businessId: string | null;
                            /** @enum {string} */
                            contentType: "image/jpeg" | "image/png" | "image/webp" | "application/pdf";
                            /** Format: date-time */
                            createdAt: string;
                            expenseId: string | null;
                            /** Format: uuid */
                            id: string;
                            originalFilename: string;
                            personalProfileId: string | null;
                            sha256Hex: string | null;
                            sizeBytes: number | null;
                            /** @enum {string} */
                            status: "PENDING" | "READY" | "FAILED" | "DELETED";
                            storageKey: string;
                            /** Format: uuid */
                            tenantId: string;
                            /** @enum {string} */
                            thumbnailStatus: "pending" | "ready" | "skipped" | "failed";
                            thumbnailStorageKey: string | null;
                            /** Format: date-time */
                            updatedAt: string;
                            version: number;
                        };
                    };
                };
                /** @description Default Response */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                410: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                413: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                500: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    businessId: string;
                    fileId: string;
                    tenantId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Default Response */
                204: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Default Response */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                410: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                413: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                500: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
            };
        };
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/tenants/{tenantId}/businesses/{businessId}/files/{fileId}/ocr-jobs": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    businessId: string;
                    fileId: string;
                    tenantId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Default Response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            items: {
                                allowedResultSchemaVersion: string;
                                businessId: string | null;
                                completedAt: string | null;
                                /** Format: date-time */
                                createdAt: string;
                                dispatchedAt: string | null;
                                errorMessage: string | null;
                                expectedAggregateVersion: number | null;
                                /** Format: uuid */
                                id: string;
                                inputParams: {
                                    [key: string]: unknown;
                                };
                                personalProfileId: string | null;
                                result: {
                                    [key: string]: unknown;
                                } | null;
                                runId: string | null;
                                /** @enum {string} */
                                status: "PENDING" | "DISPATCHED" | "RUNNING" | "SUCCEEDED" | "FAILED";
                                targetAggregateId: string | null;
                                targetAggregateType: string | null;
                                taskQueue: string;
                                /** Format: uuid */
                                tenantId: string;
                                /** Format: date-time */
                                updatedAt: string;
                                version: number;
                                workflowId: string;
                                workflowType: string;
                            }[];
                        };
                    };
                };
                /** @description Default Response */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                412: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                500: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
            };
        };
        put?: never;
        post: {
            parameters: {
                query?: never;
                header: {
                    "idempotency-key": string;
                };
                path: {
                    businessId: string;
                    fileId: string;
                    tenantId: string;
                };
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        /** @enum {string} */
                        modeKey: "ocr_mode_fast" | "ocr_mode_balanced" | "ocr_mode_accurate";
                    };
                };
            };
            responses: {
                /** @description Default Response */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            allowedResultSchemaVersion: string;
                            businessId: string | null;
                            completedAt: string | null;
                            /** Format: date-time */
                            createdAt: string;
                            dispatchedAt: string | null;
                            errorMessage: string | null;
                            expectedAggregateVersion: number | null;
                            /** Format: uuid */
                            id: string;
                            inputParams: {
                                [key: string]: unknown;
                            };
                            personalProfileId: string | null;
                            result: {
                                [key: string]: unknown;
                            } | null;
                            runId: string | null;
                            /** @enum {string} */
                            status: "PENDING" | "DISPATCHED" | "RUNNING" | "SUCCEEDED" | "FAILED";
                            targetAggregateId: string | null;
                            targetAggregateType: string | null;
                            taskQueue: string;
                            /** Format: uuid */
                            tenantId: string;
                            /** Format: date-time */
                            updatedAt: string;
                            version: number;
                            workflowId: string;
                            workflowType: string;
                        };
                    };
                };
                /** @description Default Response */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                412: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                500: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/tenants/{tenantId}/businesses/{businessId}/files/{fileId}/read-url": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    businessId: string;
                    fileId: string;
                    tenantId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Default Response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** Format: date-time */
                            expiresAt: string;
                            url: string;
                        };
                    };
                };
                /** @description Default Response */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                410: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                413: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                500: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/tenants/{tenantId}/businesses/{businessId}/files/upload-sessions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header: {
                    "idempotency-key": string;
                };
                path: {
                    businessId: string;
                    tenantId: string;
                };
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        /** @enum {string} */
                        contentType: "image/jpeg" | "image/png" | "image/webp" | "application/pdf";
                        expectedSizeBytes?: number;
                        /** Format: uuid */
                        expenseId?: string;
                        originalFilename: string;
                    };
                };
            };
            responses: {
                /** @description Default Response */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            file: {
                                businessId: string | null;
                                /** @enum {string} */
                                contentType: "image/jpeg" | "image/png" | "image/webp" | "application/pdf";
                                /** Format: date-time */
                                createdAt: string;
                                expenseId: string | null;
                                /** Format: uuid */
                                id: string;
                                originalFilename: string;
                                personalProfileId: string | null;
                                sha256Hex: string | null;
                                sizeBytes: number | null;
                                /** @enum {string} */
                                status: "PENDING" | "READY" | "FAILED" | "DELETED";
                                storageKey: string;
                                /** Format: uuid */
                                tenantId: string;
                                /** @enum {string} */
                                thumbnailStatus: "pending" | "ready" | "skipped" | "failed";
                                thumbnailStorageKey: string | null;
                                /** Format: date-time */
                                updatedAt: string;
                                version: number;
                            };
                            uploadSession: {
                                confirmedAt: string | null;
                                /** Format: date-time */
                                createdAt: string;
                                /** Format: uuid */
                                expenseFileId: string;
                                /** Format: date-time */
                                expiresAt: string;
                                /** Format: uuid */
                                id: string;
                                /** @enum {string} */
                                status: "PENDING" | "CONFIRMED" | "EXPIRED";
                            };
                            uploadTarget: {
                                /** Format: date-time */
                                expiresAt: string;
                                /** @enum {string} */
                                method: "PUT";
                                requiredHeaders: {
                                    [key: string]: string;
                                };
                                url: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                410: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                413: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                500: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/tenants/{tenantId}/businesses/{businessId}/files/upload-sessions/{sessionId}/confirm": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    businessId: string;
                    sessionId: string;
                    tenantId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Default Response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            businessId: string | null;
                            /** @enum {string} */
                            contentType: "image/jpeg" | "image/png" | "image/webp" | "application/pdf";
                            /** Format: date-time */
                            createdAt: string;
                            expenseId: string | null;
                            /** Format: uuid */
                            id: string;
                            originalFilename: string;
                            personalProfileId: string | null;
                            sha256Hex: string | null;
                            sizeBytes: number | null;
                            /** @enum {string} */
                            status: "PENDING" | "READY" | "FAILED" | "DELETED";
                            storageKey: string;
                            /** Format: uuid */
                            tenantId: string;
                            /** @enum {string} */
                            thumbnailStatus: "pending" | "ready" | "skipped" | "failed";
                            thumbnailStorageKey: string | null;
                            /** Format: date-time */
                            updatedAt: string;
                            version: number;
                        };
                    };
                };
                /** @description Default Response */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                410: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                413: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                500: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/tenants/{tenantId}/businesses/{businessId}/forwarding/inbound-emails": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    businessId: string;
                    tenantId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Default Response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            items: {
                                attachmentCount: number;
                                businessId: string | null;
                                /** Format: date-time */
                                createdAt: string;
                                /** Format: uuid */
                                id: string;
                                personalProfileId: string | null;
                                processedAt: string | null;
                                providerMessageId: string;
                                quarantineReason: ("UNKNOWN_TOKEN" | "TOKEN_REVOKED" | "SENDER_NOT_VERIFIED" | "SENDER_MISMATCH" | "EMAIL_AUTH_FAILED" | "NO_ATTACHMENTS" | "TOO_MANY_ATTACHMENTS" | "MESSAGE_TOO_LARGE" | "UNSUPPORTED_ATTACHMENT" | "INVALID_ATTACHMENT" | "MALWARE_DETECTED" | "RATE_LIMITED" | "DUPLICATE" | "ENTITLEMENT_DISABLED" | "PROCESSING_FAILED") | null;
                                recipientAddress: string;
                                senderEmail: string;
                                /** @enum {string} */
                                status: "ACCEPTED" | "QUARANTINED" | "DISMISSED";
                                subject: string | null;
                                tenantId: string | null;
                                totalBytes: number;
                            }[];
                        };
                    };
                };
                /** @description Default Response */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                500: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/tenants/{tenantId}/businesses/{businessId}/forwarding/quarantine": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    businessId: string;
                    tenantId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Default Response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            items: {
                                attachmentCount: number;
                                businessId: string | null;
                                /** Format: date-time */
                                createdAt: string;
                                /** Format: uuid */
                                id: string;
                                personalProfileId: string | null;
                                processedAt: string | null;
                                providerMessageId: string;
                                quarantineReason: ("UNKNOWN_TOKEN" | "TOKEN_REVOKED" | "SENDER_NOT_VERIFIED" | "SENDER_MISMATCH" | "EMAIL_AUTH_FAILED" | "NO_ATTACHMENTS" | "TOO_MANY_ATTACHMENTS" | "MESSAGE_TOO_LARGE" | "UNSUPPORTED_ATTACHMENT" | "INVALID_ATTACHMENT" | "MALWARE_DETECTED" | "RATE_LIMITED" | "DUPLICATE" | "ENTITLEMENT_DISABLED" | "PROCESSING_FAILED") | null;
                                recipientAddress: string;
                                senderEmail: string;
                                /** @enum {string} */
                                status: "ACCEPTED" | "QUARANTINED" | "DISMISSED";
                                subject: string | null;
                                tenantId: string | null;
                                totalBytes: number;
                            }[];
                        };
                    };
                };
                /** @description Default Response */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                500: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/tenants/{tenantId}/businesses/{businessId}/forwarding/quarantine/{inboundEmailId}/dismiss": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    businessId: string;
                    inboundEmailId: string;
                    tenantId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Default Response */
                204: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Default Response */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                500: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/tenants/{tenantId}/businesses/{businessId}/forwarding/routing-token": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    businessId: string;
                    tenantId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Default Response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            businessId: string | null;
                            /** Format: date-time */
                            createdAt: string;
                            /** Format: uuid */
                            id: string;
                            personalProfileId: string | null;
                            revokedAt: string | null;
                            /** Format: email */
                            routingAddress: string;
                            /** @enum {string} */
                            status: "active" | "revoked";
                            /** Format: uuid */
                            tenantId: string;
                        };
                    };
                };
                /** @description Default Response */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                500: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
            };
        };
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    businessId: string;
                    tenantId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Default Response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            businessId: string | null;
                            /** Format: date-time */
                            createdAt: string;
                            /** Format: uuid */
                            id: string;
                            personalProfileId: string | null;
                            revokedAt: string | null;
                            /** Format: email */
                            routingAddress: string;
                            /** @enum {string} */
                            status: "active" | "revoked";
                            /** Format: uuid */
                            tenantId: string;
                        };
                    };
                };
                /** @description Default Response */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                500: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/tenants/{tenantId}/businesses/{businessId}/forwarding/verified-senders": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    businessId: string;
                    tenantId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Default Response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            items: {
                                businessId: string | null;
                                /** Format: date-time */
                                createdAt: string;
                                /** Format: email */
                                email: string;
                                /** Format: uuid */
                                id: string;
                                personalProfileId: string | null;
                                /** @enum {string} */
                                status: "pending" | "verified" | "revoked";
                                /** Format: uuid */
                                tenantId: string;
                                verifiedAt: string | null;
                            }[];
                        };
                    };
                };
                /** @description Default Response */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                500: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
            };
        };
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    businessId: string;
                    tenantId: string;
                };
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        /** Format: email */
                        email: string;
                    };
                };
            };
            responses: {
                /** @description Default Response */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            businessId: string | null;
                            /** Format: date-time */
                            createdAt: string;
                            /** Format: email */
                            email: string;
                            /** Format: uuid */
                            id: string;
                            personalProfileId: string | null;
                            /** @enum {string} */
                            status: "pending" | "verified" | "revoked";
                            /** Format: uuid */
                            tenantId: string;
                            verifiedAt: string | null;
                        };
                    };
                };
                /** @description Default Response */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                500: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/tenants/{tenantId}/businesses/{businessId}/forwarding/verified-senders/{senderId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        delete: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    businessId: string;
                    senderId: string;
                    tenantId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Default Response */
                204: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Default Response */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                500: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
            };
        };
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/tenants/{tenantId}/businesses/{businessId}/forwarding/verified-senders/{senderId}/verify": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    businessId: string;
                    senderId: string;
                    tenantId: string;
                };
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        verificationToken: string;
                    };
                };
            };
            responses: {
                /** @description Default Response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            businessId: string | null;
                            /** Format: date-time */
                            createdAt: string;
                            /** Format: email */
                            email: string;
                            /** Format: uuid */
                            id: string;
                            personalProfileId: string | null;
                            /** @enum {string} */
                            status: "pending" | "verified" | "revoked";
                            /** Format: uuid */
                            tenantId: string;
                            verifiedAt: string | null;
                        };
                    };
                };
                /** @description Default Response */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                500: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/tenants/{tenantId}/businesses/{businessId}/memberships": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    businessId: string;
                    tenantId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Default Response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            items: {
                                /** Format: uuid */
                                businessId: string;
                                /** Format: date-time */
                                createdAt: string;
                                /** @enum {string} */
                                role: "owner" | "editor" | "viewer";
                                /** @enum {string} */
                                status: "active" | "inactive";
                                /** Format: uuid */
                                tenantId: string;
                                /** Format: date-time */
                                updatedAt: string;
                                /** Format: uuid */
                                userId: string;
                                version: number;
                            }[];
                        };
                    };
                };
                /** @description Default Response */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                500: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
            };
        };
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    businessId: string;
                    tenantId: string;
                };
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        /** @enum {string} */
                        role: "owner" | "editor" | "viewer";
                        /** Format: uuid */
                        userId: string;
                    };
                };
            };
            responses: {
                /** @description Default Response */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** Format: uuid */
                            businessId: string;
                            /** Format: date-time */
                            createdAt: string;
                            /** @enum {string} */
                            role: "owner" | "editor" | "viewer";
                            /** @enum {string} */
                            status: "active" | "inactive";
                            /** Format: uuid */
                            tenantId: string;
                            /** Format: date-time */
                            updatedAt: string;
                            /** Format: uuid */
                            userId: string;
                            version: number;
                        };
                    };
                };
                /** @description Default Response */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                500: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/tenants/{tenantId}/businesses/{businessId}/memberships/{userId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    businessId: string;
                    tenantId: string;
                    userId: string;
                };
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        expectedVersion: number;
                        /** @enum {string} */
                        role?: "owner" | "editor" | "viewer";
                        /** @enum {string} */
                        status?: "active" | "inactive";
                    };
                };
            };
            responses: {
                /** @description Default Response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** Format: uuid */
                            businessId: string;
                            /** Format: date-time */
                            createdAt: string;
                            /** @enum {string} */
                            role: "owner" | "editor" | "viewer";
                            /** @enum {string} */
                            status: "active" | "inactive";
                            /** Format: uuid */
                            tenantId: string;
                            /** Format: date-time */
                            updatedAt: string;
                            /** Format: uuid */
                            userId: string;
                            version: number;
                        };
                    };
                };
                /** @description Default Response */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                500: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
            };
        };
        trace?: never;
    };
    "/api/v1/tenants/{tenantId}/businesses/{businessId}/projects": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    businessId: string;
                    tenantId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Default Response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            items: {
                                /** Format: uuid */
                                businessId: string;
                                clientName: string | null;
                                /** Format: date-time */
                                createdAt: string;
                                description: string | null;
                                endsOn: string | null;
                                /** Format: uuid */
                                id: string;
                                name: string;
                                startsOn: string | null;
                                /** @enum {string} */
                                status: "active" | "completed" | "archived";
                                /** Format: uuid */
                                tenantId: string;
                                /** Format: date-time */
                                updatedAt: string;
                                version: number;
                            }[];
                        };
                    };
                };
                /** @description Default Response */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                500: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
            };
        };
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    businessId: string;
                    tenantId: string;
                };
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        clientName?: string | null;
                        description?: string | null;
                        endsOn?: string | null;
                        name: string;
                        startsOn?: string | null;
                    };
                };
            };
            responses: {
                /** @description Default Response */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** Format: uuid */
                            businessId: string;
                            clientName: string | null;
                            /** Format: date-time */
                            createdAt: string;
                            description: string | null;
                            endsOn: string | null;
                            /** Format: uuid */
                            id: string;
                            name: string;
                            startsOn: string | null;
                            /** @enum {string} */
                            status: "active" | "completed" | "archived";
                            /** Format: uuid */
                            tenantId: string;
                            /** Format: date-time */
                            updatedAt: string;
                            version: number;
                        };
                    };
                };
                /** @description Default Response */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                500: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/tenants/{tenantId}/businesses/{businessId}/projects/{projectId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    businessId: string;
                    projectId: string;
                    tenantId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Default Response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** Format: uuid */
                            businessId: string;
                            clientName: string | null;
                            /** Format: date-time */
                            createdAt: string;
                            description: string | null;
                            endsOn: string | null;
                            /** Format: uuid */
                            id: string;
                            name: string;
                            startsOn: string | null;
                            /** @enum {string} */
                            status: "active" | "completed" | "archived";
                            /** Format: uuid */
                            tenantId: string;
                            /** Format: date-time */
                            updatedAt: string;
                            version: number;
                        };
                    };
                };
                /** @description Default Response */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                500: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    businessId: string;
                    projectId: string;
                    tenantId: string;
                };
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        expectedVersion: number;
                    };
                };
            };
            responses: {
                /** @description Default Response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** Format: uuid */
                            businessId: string;
                            clientName: string | null;
                            /** Format: date-time */
                            createdAt: string;
                            description: string | null;
                            endsOn: string | null;
                            /** Format: uuid */
                            id: string;
                            name: string;
                            startsOn: string | null;
                            /** @enum {string} */
                            status: "active" | "completed" | "archived";
                            /** Format: uuid */
                            tenantId: string;
                            /** Format: date-time */
                            updatedAt: string;
                            version: number;
                        };
                    };
                };
                /** @description Default Response */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                500: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
            };
        };
        options?: never;
        head?: never;
        patch: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    businessId: string;
                    projectId: string;
                    tenantId: string;
                };
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        clientName?: string | null;
                        description?: string | null;
                        endsOn?: string | null;
                        expectedVersion: number;
                        name?: string;
                        startsOn?: string | null;
                        /** @enum {string} */
                        status?: "active" | "completed";
                    };
                };
            };
            responses: {
                /** @description Default Response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** Format: uuid */
                            businessId: string;
                            clientName: string | null;
                            /** Format: date-time */
                            createdAt: string;
                            description: string | null;
                            endsOn: string | null;
                            /** Format: uuid */
                            id: string;
                            name: string;
                            startsOn: string | null;
                            /** @enum {string} */
                            status: "active" | "completed" | "archived";
                            /** Format: uuid */
                            tenantId: string;
                            /** Format: date-time */
                            updatedAt: string;
                            version: number;
                        };
                    };
                };
                /** @description Default Response */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                500: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
            };
        };
        trace?: never;
    };
    "/api/v1/tenants/{tenantId}/businesses/{businessId}/projects/{projectId}/cost-report": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    businessId: string;
                    projectId: string;
                    tenantId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Default Response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            baseCurrency: string;
                            /** Format: uuid */
                            businessId: string;
                            byMonth: {
                                deductibleTotal: string;
                                expenseCount: number;
                                grossTotal: string;
                                month: string;
                            }[];
                            bySpendingCategory: {
                                categoryId: string | null;
                                categoryName: string;
                                expenseCount: number;
                                grossTotal: string;
                            }[];
                            foreignCurrencySummary: {
                                currencies: string[];
                                excludedCount: number;
                            };
                            /** Format: uuid */
                            projectId: string;
                            projectName: string;
                            totals: {
                                currency: string;
                                deductibleTotal: string;
                                expenseCount: number;
                                grossTotal: string;
                            };
                            totalsByCurrency: {
                                currency: string;
                                deductibleTotal: string;
                                expenseCount: number;
                                grossTotal: string;
                            }[];
                        };
                    };
                };
                /** @description Default Response */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                500: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/tenants/{tenantId}/businesses/{businessId}/tax-profiles": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    businessId: string;
                    tenantId: string;
                };
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        /** @enum {string} */
                        accountingMethod: "cash" | "accrual";
                        taxYear: number;
                    };
                };
            };
            responses: {
                /** @description Default Response */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {string} */
                            accountingMethod: "cash" | "accrual";
                            /** Format: uuid */
                            businessId: string;
                            /** Format: date-time */
                            createdAt: string;
                            /** Format: uuid */
                            id: string;
                            /** @enum {string} */
                            status: "draft" | "active" | "closed";
                            /** @enum {string} */
                            taxForm: "schedule_c";
                            /** Format: uuid */
                            taxonomyVersionId: string;
                            taxYear: number;
                            /** Format: uuid */
                            tenantId: string;
                            /** Format: date-time */
                            updatedAt: string;
                            version: number;
                        };
                    };
                };
                /** @description Default Response */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                500: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/tenants/{tenantId}/businesses/{businessId}/tax-profiles/{taxYear}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    businessId: string;
                    taxYear: number;
                    tenantId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Default Response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {string} */
                            accountingMethod: "cash" | "accrual";
                            /** Format: uuid */
                            businessId: string;
                            /** Format: date-time */
                            createdAt: string;
                            /** Format: uuid */
                            id: string;
                            /** @enum {string} */
                            status: "draft" | "active" | "closed";
                            /** @enum {string} */
                            taxForm: "schedule_c";
                            /** Format: uuid */
                            taxonomyVersionId: string;
                            taxYear: number;
                            /** Format: uuid */
                            tenantId: string;
                            /** Format: date-time */
                            updatedAt: string;
                            version: number;
                        };
                    };
                };
                /** @description Default Response */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                500: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    businessId: string;
                    taxYear: number;
                    tenantId: string;
                };
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        expectedVersion: number;
                    };
                };
            };
            responses: {
                /** @description Default Response */
                204: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Default Response */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                500: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
            };
        };
        options?: never;
        head?: never;
        patch: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    businessId: string;
                    taxYear: number;
                    tenantId: string;
                };
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        /** @enum {string} */
                        accountingMethod?: "cash" | "accrual";
                        expectedVersion: number;
                        /** @enum {string} */
                        status?: "draft" | "active" | "closed";
                    };
                };
            };
            responses: {
                /** @description Default Response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {string} */
                            accountingMethod: "cash" | "accrual";
                            /** Format: uuid */
                            businessId: string;
                            /** Format: date-time */
                            createdAt: string;
                            /** Format: uuid */
                            id: string;
                            /** @enum {string} */
                            status: "draft" | "active" | "closed";
                            /** @enum {string} */
                            taxForm: "schedule_c";
                            /** Format: uuid */
                            taxonomyVersionId: string;
                            taxYear: number;
                            /** Format: uuid */
                            tenantId: string;
                            /** Format: date-time */
                            updatedAt: string;
                            version: number;
                        };
                    };
                };
                /** @description Default Response */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                500: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
            };
        };
        trace?: never;
    };
    "/api/v1/tenants/{tenantId}/businesses/{businessId}/tax-reports/{taxYear}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    businessId: string;
                    taxYear: number;
                    tenantId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Default Response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            baseCurrency: string;
                            /** Format: uuid */
                            businessId: string;
                            byCategory: {
                                categoryCode: string | null;
                                categoryName: string;
                                deductibleTotal: string;
                                expenseCount: number;
                                grossTotal: string;
                            }[];
                            byMonth: {
                                deductibleTotal: string;
                                expenseCount: number;
                                grossTotal: string;
                                month: string;
                            }[];
                            foreignCurrencySummary: {
                                currencies: string[];
                                excludedCount: number;
                            };
                            profile: {
                                /** Format: uuid */
                                id: string;
                                status: string;
                                /** Format: uuid */
                                taxonomyVersionId: string;
                            } | null;
                            review: {
                                excluded: number;
                                missingTreatment: number;
                                reviewed: number;
                                total: number;
                                treated: number;
                                unreviewed: number;
                            };
                            taxYear: number;
                            totals: {
                                currency: string;
                                deductibleTotal: string;
                                expenseCount: number;
                                grossTotal: string;
                            };
                            totalsByCurrency: {
                                currency: string;
                                deductibleTotal: string;
                                expenseCount: number;
                                grossTotal: string;
                            }[];
                        };
                    };
                };
                /** @description Default Response */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                500: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/tenants/{tenantId}/entitlements": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    tenantId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Default Response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            items: {
                                /** @enum {string} */
                                featureKey: "receipt_forwarding" | "connected_mailbox_scan" | "ai_search" | "ocr_mode_fast" | "ocr_mode_balanced" | "ocr_mode_accurate";
                                isEnabled: boolean;
                                limitPeriod: ("monthly" | "unlimited") | null;
                                limitValue: number | null;
                                /** @enum {string} */
                                source: "plan" | "addon" | "override";
                            }[];
                        };
                    };
                };
                /** @description Default Response */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                500: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/tenants/{tenantId}/invitations": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    tenantId: string;
                };
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        email: string;
                        grant: {
                            /** @enum {string} */
                            type: "none";
                        } | {
                            /** Format: uuid */
                            profileId: string;
                            /** @enum {string} */
                            role: "owner" | "editor" | "viewer";
                            /** @enum {string} */
                            type: "personal";
                        } | {
                            /** Format: uuid */
                            businessId: string;
                            /** @enum {string} */
                            role: "owner" | "editor" | "viewer";
                            /** @enum {string} */
                            type: "business";
                        };
                        /** @enum {string} */
                        tenantRole: "owner" | "admin" | "member";
                    };
                };
            };
            responses: {
                /** @description Default Response */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            invitation: {
                                acceptedAt: string | null;
                                acceptedByUserId: string | null;
                                /** Format: date-time */
                                createdAt: string;
                                /** Format: uuid */
                                createdByUserId: string;
                                /** Format: email */
                                email: string;
                                /** Format: date-time */
                                expiresAt: string;
                                grant: {
                                    /** @enum {string} */
                                    type: "none";
                                } | {
                                    /** Format: uuid */
                                    profileId: string;
                                    /** @enum {string} */
                                    role: "owner" | "editor" | "viewer";
                                    /** @enum {string} */
                                    type: "personal";
                                } | {
                                    /** Format: uuid */
                                    businessId: string;
                                    /** @enum {string} */
                                    role: "owner" | "editor" | "viewer";
                                    /** @enum {string} */
                                    type: "business";
                                };
                                /** Format: uuid */
                                id: string;
                                revokedAt: string | null;
                                /** Format: uuid */
                                tenantId: string;
                                /** @enum {string} */
                                tenantRole: "owner" | "admin" | "member";
                            };
                            invitationToken: string;
                        };
                    };
                };
                /** @description Default Response */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                500: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/tenants/{tenantId}/mailbox-connections/{connectionId}/candidates": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: {
            parameters: {
                query?: {
                    bucket?: "in_progress" | "needs_attention" | "completed";
                    classification?: "receipt" | "ambiguous" | "not_receipt";
                    cursor?: string;
                    limit?: number;
                };
                header?: never;
                path: {
                    connectionId: string;
                    tenantId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Default Response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            items: {
                                attachmentManifest: {
                                    /** @enum {string} */
                                    mimeType: "image/jpeg" | "image/png" | "image/webp" | "application/pdf";
                                    name: string;
                                    sha256: string;
                                    sizeBytes: number;
                                }[];
                                /** @enum {string} */
                                classification: "receipt" | "ambiguous" | "not_receipt";
                                confidence: number;
                                /** Format: uuid */
                                connectionId: string;
                                contentHash: string;
                                /** Format: date-time */
                                createdAt: string;
                                duplicateMatchId: string | null;
                                errorCode: ("ENTITLEMENT_DISABLED" | "SCOPE_ACCESS_DENIED" | "CONNECTION_NOT_FOUND" | "PROVIDER_UNSUPPORTED" | "OAUTH_ATTEMPT_EXPIRED" | "OAUTH_STATE_INVALID" | "OAUTH_REPLAY" | "OAUTH_SCOPE_MISMATCH" | "GOOGLE_REAUTH_REQUIRED" | "GOOGLE_RATE_LIMITED" | "GOOGLE_UNAVAILABLE" | "VERSION_CONFLICT" | "IDEMPOTENCY_CONFLICT" | "REVOKE_PENDING" | "ATTACHMENT_BOUND_EXCEEDED" | "ATTACHMENT_SIGNATURE_REJECTED" | "STRUCTURED_RECEIPT_BOUND_EXCEEDED" | "STRUCTURED_RECEIPT_NOT_FOUND" | "STRUCTURED_RECEIPT_INCOMPLETE" | "ATTACHMENT_HASH_MISMATCH" | "MALWARE_DETECTED" | "OCR_EXTRACTION_FAILED" | "ATTACHMENT_CONFIRMATION_FAILED" | "MAILBOX_MATERIALIZE_FAILED") | null;
                                evidence: string[];
                                expenseId: string | null;
                                /** Format: uuid */
                                id: string;
                                idempotencyKey: string;
                                ingestionProgress: {
                                    attachments: {
                                        failed: number;
                                        pending: number;
                                        succeeded: number;
                                        total: number;
                                    };
                                    /** @enum {string} */
                                    phase: "materializing" | "processing_attachments";
                                } | null;
                                processingJobId: string | null;
                                /** Format: date-time */
                                receivedAt: string;
                                /** Format: uuid */
                                scanRunId: string;
                                /** @enum {number} */
                                schemaVersion: 1;
                                scope: ({
                                    /** @enum {string} */
                                    kind: "personal";
                                    /** Format: uuid */
                                    profileId: string;
                                } | {
                                    /** Format: uuid */
                                    businessId: string;
                                    /** @enum {string} */
                                    kind: "business";
                                }) | null;
                                /** Format: email */
                                senderAddress: string;
                                senderDomain: string;
                                sourceId: string | null;
                                /** @enum {string} */
                                status: "staged" | "review" | "queued" | "processed" | "duplicate" | "skipped" | "failed";
                                subject: string;
                                /** Format: uuid */
                                tenantId: string;
                                /** Format: date-time */
                                updatedAt: string;
                                version: number;
                            }[];
                            nextCursor: string | null;
                            totalCount?: number;
                        };
                    };
                };
                /** @description Default Response */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/tenants/{tenantId}/mailbox-connections/{connectionId}/candidates/{candidateId}/resolve": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    candidateId: string;
                    connectionId: string;
                    tenantId: string;
                };
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        /** @enum {string} */
                        action: "ingest" | "skip" | "not_receipt" | "retry";
                        expectedCandidateVersion: number;
                        requestId: string;
                        scope?: {
                            /** @enum {string} */
                            kind: "personal";
                            /** Format: uuid */
                            profileId: string;
                        } | {
                            /** Format: uuid */
                            businessId: string;
                            /** @enum {string} */
                            kind: "business";
                        };
                    };
                };
            };
            responses: {
                /** @description Default Response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            attachmentManifest: {
                                /** @enum {string} */
                                mimeType: "image/jpeg" | "image/png" | "image/webp" | "application/pdf";
                                name: string;
                                sha256: string;
                                sizeBytes: number;
                            }[];
                            /** @enum {string} */
                            classification: "receipt" | "ambiguous" | "not_receipt";
                            confidence: number;
                            /** Format: uuid */
                            connectionId: string;
                            contentHash: string;
                            /** Format: date-time */
                            createdAt: string;
                            duplicateMatchId: string | null;
                            errorCode: ("ENTITLEMENT_DISABLED" | "SCOPE_ACCESS_DENIED" | "CONNECTION_NOT_FOUND" | "PROVIDER_UNSUPPORTED" | "OAUTH_ATTEMPT_EXPIRED" | "OAUTH_STATE_INVALID" | "OAUTH_REPLAY" | "OAUTH_SCOPE_MISMATCH" | "GOOGLE_REAUTH_REQUIRED" | "GOOGLE_RATE_LIMITED" | "GOOGLE_UNAVAILABLE" | "VERSION_CONFLICT" | "IDEMPOTENCY_CONFLICT" | "REVOKE_PENDING" | "ATTACHMENT_BOUND_EXCEEDED" | "ATTACHMENT_SIGNATURE_REJECTED" | "STRUCTURED_RECEIPT_BOUND_EXCEEDED" | "STRUCTURED_RECEIPT_NOT_FOUND" | "STRUCTURED_RECEIPT_INCOMPLETE" | "ATTACHMENT_HASH_MISMATCH" | "MALWARE_DETECTED" | "OCR_EXTRACTION_FAILED" | "ATTACHMENT_CONFIRMATION_FAILED" | "MAILBOX_MATERIALIZE_FAILED") | null;
                            evidence: string[];
                            expenseId: string | null;
                            /** Format: uuid */
                            id: string;
                            idempotencyKey: string;
                            ingestionProgress: {
                                attachments: {
                                    failed: number;
                                    pending: number;
                                    succeeded: number;
                                    total: number;
                                };
                                /** @enum {string} */
                                phase: "materializing" | "processing_attachments";
                            } | null;
                            processingJobId: string | null;
                            /** Format: date-time */
                            receivedAt: string;
                            /** Format: uuid */
                            scanRunId: string;
                            /** @enum {number} */
                            schemaVersion: 1;
                            scope: ({
                                /** @enum {string} */
                                kind: "personal";
                                /** Format: uuid */
                                profileId: string;
                            } | {
                                /** Format: uuid */
                                businessId: string;
                                /** @enum {string} */
                                kind: "business";
                            }) | null;
                            /** Format: email */
                            senderAddress: string;
                            senderDomain: string;
                            sourceId: string | null;
                            /** @enum {string} */
                            status: "staged" | "review" | "queued" | "processed" | "duplicate" | "skipped" | "failed";
                            subject: string;
                            /** Format: uuid */
                            tenantId: string;
                            /** Format: date-time */
                            updatedAt: string;
                            version: number;
                        };
                    };
                };
                /** @description Default Response */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/tenants/{tenantId}/mailbox-connections/{connectionId}/scans": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    connectionId: string;
                    tenantId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Default Response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            items: {
                                completedAt: string | null;
                                /** Format: uuid */
                                connectionId: string;
                                connectionVersion: number;
                                /** Format: date-time */
                                createdAt: string;
                                discoveredCount: number;
                                duplicateCount: number;
                                entitlementVersion: number;
                                errorCode: ("ENTITLEMENT_DISABLED" | "SCOPE_ACCESS_DENIED" | "CONNECTION_NOT_FOUND" | "PROVIDER_UNSUPPORTED" | "OAUTH_ATTEMPT_EXPIRED" | "OAUTH_STATE_INVALID" | "OAUTH_REPLAY" | "OAUTH_SCOPE_MISMATCH" | "GOOGLE_REAUTH_REQUIRED" | "GOOGLE_RATE_LIMITED" | "GOOGLE_UNAVAILABLE" | "VERSION_CONFLICT" | "IDEMPOTENCY_CONFLICT" | "REVOKE_PENDING" | "ATTACHMENT_BOUND_EXCEEDED" | "ATTACHMENT_SIGNATURE_REJECTED" | "STRUCTURED_RECEIPT_BOUND_EXCEEDED" | "STRUCTURED_RECEIPT_NOT_FOUND" | "STRUCTURED_RECEIPT_INCOMPLETE" | "ATTACHMENT_HASH_MISMATCH" | "MALWARE_DETECTED" | "OCR_EXTRACTION_FAILED" | "ATTACHMENT_CONFIRMATION_FAILED" | "MAILBOX_MATERIALIZE_FAILED") | null;
                                failedCount: number;
                                /** Format: uuid */
                                id: string;
                                idempotencyKey: string;
                                initiatedBy: string | "schedule";
                                reviewCount: number;
                                /** @enum {number} */
                                schemaVersion: 1;
                                skippedCount: number;
                                stagedCount: number;
                                startedAt: string | null;
                                /** @enum {string} */
                                status: "pending" | "running" | "completed" | "partial" | "failed" | "skipped";
                                /** Format: uuid */
                                tenantId: string;
                            }[];
                        };
                    };
                };
                /** @description Default Response */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                410: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
            };
        };
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    connectionId: string;
                    tenantId: string;
                };
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        requestId: string;
                    };
                };
            };
            responses: {
                /** @description Default Response */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            scanRun: {
                                completedAt: string | null;
                                /** Format: uuid */
                                connectionId: string;
                                connectionVersion: number;
                                /** Format: date-time */
                                createdAt: string;
                                discoveredCount: number;
                                duplicateCount: number;
                                entitlementVersion: number;
                                errorCode: ("ENTITLEMENT_DISABLED" | "SCOPE_ACCESS_DENIED" | "CONNECTION_NOT_FOUND" | "PROVIDER_UNSUPPORTED" | "OAUTH_ATTEMPT_EXPIRED" | "OAUTH_STATE_INVALID" | "OAUTH_REPLAY" | "OAUTH_SCOPE_MISMATCH" | "GOOGLE_REAUTH_REQUIRED" | "GOOGLE_RATE_LIMITED" | "GOOGLE_UNAVAILABLE" | "VERSION_CONFLICT" | "IDEMPOTENCY_CONFLICT" | "REVOKE_PENDING" | "ATTACHMENT_BOUND_EXCEEDED" | "ATTACHMENT_SIGNATURE_REJECTED" | "STRUCTURED_RECEIPT_BOUND_EXCEEDED" | "STRUCTURED_RECEIPT_NOT_FOUND" | "STRUCTURED_RECEIPT_INCOMPLETE" | "ATTACHMENT_HASH_MISMATCH" | "MALWARE_DETECTED" | "OCR_EXTRACTION_FAILED" | "ATTACHMENT_CONFIRMATION_FAILED" | "MAILBOX_MATERIALIZE_FAILED") | null;
                                failedCount: number;
                                /** Format: uuid */
                                id: string;
                                idempotencyKey: string;
                                initiatedBy: string | "schedule";
                                reviewCount: number;
                                /** @enum {number} */
                                schemaVersion: 1;
                                skippedCount: number;
                                stagedCount: number;
                                startedAt: string | null;
                                /** @enum {string} */
                                status: "pending" | "running" | "completed" | "partial" | "failed" | "skipped";
                                /** Format: uuid */
                                tenantId: string;
                            };
                            /** @enum {string} */
                            status: "started" | "skipped_overlap";
                        };
                    };
                };
                /** @description Default Response */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            scanRun: {
                                completedAt: string | null;
                                /** Format: uuid */
                                connectionId: string;
                                connectionVersion: number;
                                /** Format: date-time */
                                createdAt: string;
                                discoveredCount: number;
                                duplicateCount: number;
                                entitlementVersion: number;
                                errorCode: ("ENTITLEMENT_DISABLED" | "SCOPE_ACCESS_DENIED" | "CONNECTION_NOT_FOUND" | "PROVIDER_UNSUPPORTED" | "OAUTH_ATTEMPT_EXPIRED" | "OAUTH_STATE_INVALID" | "OAUTH_REPLAY" | "OAUTH_SCOPE_MISMATCH" | "GOOGLE_REAUTH_REQUIRED" | "GOOGLE_RATE_LIMITED" | "GOOGLE_UNAVAILABLE" | "VERSION_CONFLICT" | "IDEMPOTENCY_CONFLICT" | "REVOKE_PENDING" | "ATTACHMENT_BOUND_EXCEEDED" | "ATTACHMENT_SIGNATURE_REJECTED" | "STRUCTURED_RECEIPT_BOUND_EXCEEDED" | "STRUCTURED_RECEIPT_NOT_FOUND" | "STRUCTURED_RECEIPT_INCOMPLETE" | "ATTACHMENT_HASH_MISMATCH" | "MALWARE_DETECTED" | "OCR_EXTRACTION_FAILED" | "ATTACHMENT_CONFIRMATION_FAILED" | "MAILBOX_MATERIALIZE_FAILED") | null;
                                failedCount: number;
                                /** Format: uuid */
                                id: string;
                                idempotencyKey: string;
                                initiatedBy: string | "schedule";
                                reviewCount: number;
                                /** @enum {number} */
                                schemaVersion: 1;
                                skippedCount: number;
                                stagedCount: number;
                                startedAt: string | null;
                                /** @enum {string} */
                                status: "pending" | "running" | "completed" | "partial" | "failed" | "skipped";
                                /** Format: uuid */
                                tenantId: string;
                            };
                            /** @enum {string} */
                            status: "started" | "skipped_overlap";
                        };
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/tenants/{tenantId}/mailbox-connections/google": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: {
            parameters: {
                query?: {
                    businessId?: string;
                    profileId?: string;
                };
                header?: never;
                path: {
                    tenantId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Default Response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            connection: {
                                /** Format: email */
                                accountEmail: string;
                                /** Format: date-time */
                                createdAt: string;
                                grantedScopes: string[];
                                /** Format: uuid */
                                id: string;
                                lastScanAt: string | null;
                                localScanTime: string;
                                nextScheduleAt: string | null;
                                /** Format: uuid */
                                ownerUserId: string;
                                /** @enum {string} */
                                provider: "gmail" | "outlook";
                                providerAccountId: string;
                                revokedAt: string | null;
                                scanEnabled: boolean;
                                /** @enum {number} */
                                schemaVersion: 1;
                                scope: {
                                    /** @enum {string} */
                                    kind: "personal";
                                    /** Format: uuid */
                                    profileId: string;
                                } | {
                                    /** Format: uuid */
                                    businessId: string;
                                    /** @enum {string} */
                                    kind: "business";
                                };
                                /** @enum {string} */
                                status: "pending" | "active" | "paused" | "reauth_required" | "disconnecting" | "revocation_pending" | "revoked";
                                /** Format: uuid */
                                tenantId: string;
                                timezone: string;
                                /** Format: date-time */
                                updatedAt: string;
                            } | null;
                        };
                    };
                };
                /** @description Default Response */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                410: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/tenants/{tenantId}/mailbox-connections/google/start": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    tenantId: string;
                };
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        localScanTime: string;
                        redirectOrigin: string;
                        requestId: string;
                        scope: {
                            /** @enum {string} */
                            kind: "personal";
                            /** Format: uuid */
                            profileId: string;
                        } | {
                            /** Format: uuid */
                            businessId: string;
                            /** @enum {string} */
                            kind: "business";
                        };
                        timezone: string;
                    };
                };
            };
            responses: {
                /** @description Default Response */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            attempt: {
                                /** Format: uuid */
                                actorUserId: string;
                                completedAt: string | null;
                                /** Format: uuid */
                                connectionId: string;
                                consumedAt: string | null;
                                /** Format: date-time */
                                createdAt: string;
                                /** Format: date-time */
                                expiresAt: string;
                                /** Format: uuid */
                                id: string;
                                redirectOrigin: string;
                                /** @enum {number} */
                                schemaVersion: 1;
                                sessionNonceDigest: string;
                                stateDigest: string;
                                /** @enum {string} */
                                status: "pending" | "consumed" | "completed" | "expired" | "cancelled";
                                /** Format: uuid */
                                tenantId: string;
                            };
                            authorizationUrl: string;
                            connection: {
                                /** Format: email */
                                accountEmail: string;
                                /** Format: date-time */
                                createdAt: string;
                                grantedScopes: string[];
                                /** Format: uuid */
                                id: string;
                                lastScanAt: string | null;
                                localScanTime: string;
                                nextScheduleAt: string | null;
                                /** Format: uuid */
                                ownerUserId: string;
                                /** @enum {string} */
                                provider: "gmail" | "outlook";
                                providerAccountId: string;
                                revokedAt: string | null;
                                scanEnabled: boolean;
                                /** @enum {number} */
                                schemaVersion: 1;
                                scope: {
                                    /** @enum {string} */
                                    kind: "personal";
                                    /** Format: uuid */
                                    profileId: string;
                                } | {
                                    /** Format: uuid */
                                    businessId: string;
                                    /** @enum {string} */
                                    kind: "business";
                                };
                                /** @enum {string} */
                                status: "pending" | "active" | "paused" | "reauth_required" | "disconnecting" | "revocation_pending" | "revoked";
                                /** Format: uuid */
                                tenantId: string;
                                timezone: string;
                                /** Format: date-time */
                                updatedAt: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                410: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/tenants/{tenantId}/memberships": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    tenantId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Default Response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            items: {
                                /** Format: date-time */
                                createdAt: string;
                                /** @enum {string} */
                                role: "owner" | "admin" | "member";
                                /** @enum {string} */
                                status: "active" | "inactive";
                                /** Format: uuid */
                                tenantId: string;
                                /** Format: date-time */
                                updatedAt: string;
                                /** Format: uuid */
                                userId: string;
                                version: number;
                            }[];
                        };
                    };
                };
                /** @description Default Response */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                500: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/tenants/{tenantId}/memberships/{userId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    tenantId: string;
                    userId: string;
                };
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        expectedVersion: number;
                        /** @enum {string} */
                        role?: "owner" | "admin" | "member";
                        /** @enum {string} */
                        status?: "active" | "inactive";
                    };
                };
            };
            responses: {
                /** @description Default Response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** Format: date-time */
                            createdAt: string;
                            /** @enum {string} */
                            role: "owner" | "admin" | "member";
                            /** @enum {string} */
                            status: "active" | "inactive";
                            /** Format: uuid */
                            tenantId: string;
                            /** Format: date-time */
                            updatedAt: string;
                            /** Format: uuid */
                            userId: string;
                            version: number;
                        };
                    };
                };
                /** @description Default Response */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                500: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
            };
        };
        trace?: never;
    };
    "/api/v1/tenants/{tenantId}/personal-profiles/{profileId}/duplicate-matches": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: {
            parameters: {
                query?: {
                    cursor?: string;
                    limit?: number;
                    status?: "pending" | "merged" | "separate" | "dismissed";
                };
                header?: never;
                path: {
                    profileId: string;
                    tenantId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Default Response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            items: {
                                businessId: string | null;
                                /** Format: uuid */
                                candidateExpenseId: string;
                                confidence: number;
                                /** Format: date-time */
                                createdAt: string;
                                evidence: {
                                    amountDifferencePercent?: number;
                                    amountMinorUnits?: number;
                                    candidateAmountMinorUnits?: number;
                                    /** Format: date */
                                    candidateIncurredOn?: string;
                                    currency?: string;
                                    existingAmountMinorUnits?: number;
                                    /** Format: date */
                                    existingIncurredOn?: string;
                                    fileSha256?: string;
                                    fingerprintHash?: string;
                                    /** Format: date */
                                    incurredOn?: string;
                                    incurredOnDifferenceDays?: number;
                                    normalizedMerchant?: string;
                                };
                                /** Format: uuid */
                                existingExpenseId: string;
                                /** Format: uuid */
                                id: string;
                                idempotencyKey: string;
                                /** @enum {string} */
                                matchType: "file_sha256" | "fingerprint" | "fuzzy_fields";
                                personalProfileId: string | null;
                                resolutionIdempotencyKey: string | null;
                                resolvedAt: string | null;
                                resolvedBy: string | null;
                                /** @enum {string} */
                                status: "pending" | "merged" | "separate" | "dismissed";
                                /** Format: uuid */
                                tenantId: string;
                                version: number;
                            }[];
                            nextCursor: string | null;
                        };
                    };
                };
                /** @description Default Response */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                500: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/tenants/{tenantId}/personal-profiles/{profileId}/duplicate-matches/{matchId}/resolve": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    matchId: string;
                    profileId: string;
                    tenantId: string;
                };
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        /** @enum {string} */
                        action: "merge" | "keep_both" | "discard_new";
                        expectedMatchVersion: number;
                        idempotencyKey: string;
                    };
                };
            };
            responses: {
                /** @description Default Response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {string} */
                            action: "merge" | "keep_both" | "discard_new";
                            idempotencyKey: string;
                            /** Format: uuid */
                            matchId: string;
                            /** @enum {string} */
                            status: "pending" | "merged" | "separate" | "dismissed";
                            version: number;
                        };
                    };
                };
                /** @description Default Response */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                500: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/tenants/{tenantId}/personal-profiles/{profileId}/expenses": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: {
            parameters: {
                query?: {
                    amountMax?: string;
                    amountMin?: string;
                    cursor?: string;
                    direction?: "asc" | "desc";
                    incurredFrom?: string;
                    incurredTo?: string;
                    limit?: number;
                    projectId?: string;
                    sort?: "incurredOn" | "amount" | "merchant" | "createdAt";
                    spendingCategoryId?: string;
                    status?: "draft" | "ready" | "archived";
                    tagId?: string | string[];
                    taxReviewStatus?: "unreviewed" | "reviewed" | "excluded";
                };
                header?: never;
                path: {
                    profileId: string;
                    tenantId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Default Response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            items: {
                                amount: string;
                                businessId: string | null;
                                /** Format: date-time */
                                createdAt: string;
                                /** Format: uuid */
                                createdByUserId: string;
                                currency: string;
                                description: string | null;
                                /** Format: uuid */
                                id: string;
                                /** Format: date */
                                incurredOn: string;
                                mailboxProvenance: {
                                    /** Format: email */
                                    mailboxAccountEmail: string;
                                    pendingDuplicateReview: boolean;
                                    /** Format: date-time */
                                    receivedAt: string;
                                    /** Format: email */
                                    senderAddress: string;
                                } | null;
                                merchant: string;
                                personalProfileId: string | null;
                                projectId: string | null;
                                /** @enum {string} */
                                source: "manual" | "ocr" | "forwarded_email" | "connected_mailbox";
                                spendingCategoryId: string | null;
                                /** @enum {string} */
                                status: "draft" | "ready" | "archived";
                                /** @default [] */
                                tags: {
                                    color: string | null;
                                    /** Format: uuid */
                                    id: string;
                                    name: string;
                                }[];
                                taxYear: number;
                                /** Format: uuid */
                                tenantId: string;
                                /** Format: date-time */
                                updatedAt: string;
                                version: number;
                            }[];
                            nextCursor: string | null;
                        };
                    };
                };
                /** @description Default Response */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                500: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
            };
        };
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    profileId: string;
                    tenantId: string;
                };
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        amount: string;
                        businessId?: string | null;
                        currency: string;
                        description?: string | null;
                        /** Format: date */
                        incurredOn: string;
                        merchant: string;
                        personalProfileId?: string | null;
                        projectId?: string | null;
                        spendingCategoryId?: string | null;
                    };
                };
            };
            responses: {
                /** @description Default Response */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            amount: string;
                            businessId: string | null;
                            /** Format: date-time */
                            createdAt: string;
                            /** Format: uuid */
                            createdByUserId: string;
                            currency: string;
                            description: string | null;
                            /** Format: uuid */
                            id: string;
                            /** Format: date */
                            incurredOn: string;
                            mailboxProvenance: {
                                /** Format: email */
                                mailboxAccountEmail: string;
                                pendingDuplicateReview: boolean;
                                /** Format: date-time */
                                receivedAt: string;
                                /** Format: email */
                                senderAddress: string;
                            } | null;
                            merchant: string;
                            personalProfileId: string | null;
                            projectId: string | null;
                            /** @enum {string} */
                            source: "manual" | "ocr" | "forwarded_email" | "connected_mailbox";
                            spendingCategoryId: string | null;
                            /** @enum {string} */
                            status: "draft" | "ready" | "archived";
                            /** @default [] */
                            tags: {
                                color: string | null;
                                /** Format: uuid */
                                id: string;
                                name: string;
                            }[];
                            taxYear: number;
                            /** Format: uuid */
                            tenantId: string;
                            /** Format: date-time */
                            updatedAt: string;
                            version: number;
                        };
                    };
                };
                /** @description Default Response */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                500: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/tenants/{tenantId}/personal-profiles/{profileId}/expenses/{expenseId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    expenseId: string;
                    profileId: string;
                    tenantId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Default Response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            amount: string;
                            businessId: string | null;
                            /** Format: date-time */
                            createdAt: string;
                            /** Format: uuid */
                            createdByUserId: string;
                            currency: string;
                            description: string | null;
                            /** Format: uuid */
                            id: string;
                            /** Format: date */
                            incurredOn: string;
                            mailboxProvenance: {
                                /** Format: email */
                                mailboxAccountEmail: string;
                                pendingDuplicateReview: boolean;
                                /** Format: date-time */
                                receivedAt: string;
                                /** Format: email */
                                senderAddress: string;
                            } | null;
                            merchant: string;
                            personalProfileId: string | null;
                            projectId: string | null;
                            /** @enum {string} */
                            source: "manual" | "ocr" | "forwarded_email" | "connected_mailbox";
                            spendingCategoryId: string | null;
                            /** @enum {string} */
                            status: "draft" | "ready" | "archived";
                            /** @default [] */
                            tags: {
                                color: string | null;
                                /** Format: uuid */
                                id: string;
                                name: string;
                            }[];
                            taxYear: number;
                            /** Format: uuid */
                            tenantId: string;
                            /** Format: date-time */
                            updatedAt: string;
                            version: number;
                        };
                    };
                };
                /** @description Default Response */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                500: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    expenseId: string;
                    profileId: string;
                    tenantId: string;
                };
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        expectedVersion: number;
                    };
                };
            };
            responses: {
                /** @description Default Response */
                204: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Default Response */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                500: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
            };
        };
        options?: never;
        head?: never;
        patch: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    expenseId: string;
                    profileId: string;
                    tenantId: string;
                };
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        amount?: string;
                        currency?: string;
                        description?: string | null;
                        expectedVersion: number;
                        /** Format: date */
                        incurredOn?: string;
                        merchant?: string;
                        projectId?: string | null;
                        spendingCategoryId?: string | null;
                        /** @enum {string} */
                        status?: "draft" | "ready";
                    };
                };
            };
            responses: {
                /** @description Default Response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            amount: string;
                            businessId: string | null;
                            /** Format: date-time */
                            createdAt: string;
                            /** Format: uuid */
                            createdByUserId: string;
                            currency: string;
                            description: string | null;
                            /** Format: uuid */
                            id: string;
                            /** Format: date */
                            incurredOn: string;
                            mailboxProvenance: {
                                /** Format: email */
                                mailboxAccountEmail: string;
                                pendingDuplicateReview: boolean;
                                /** Format: date-time */
                                receivedAt: string;
                                /** Format: email */
                                senderAddress: string;
                            } | null;
                            merchant: string;
                            personalProfileId: string | null;
                            projectId: string | null;
                            /** @enum {string} */
                            source: "manual" | "ocr" | "forwarded_email" | "connected_mailbox";
                            spendingCategoryId: string | null;
                            /** @enum {string} */
                            status: "draft" | "ready" | "archived";
                            /** @default [] */
                            tags: {
                                color: string | null;
                                /** Format: uuid */
                                id: string;
                                name: string;
                            }[];
                            taxYear: number;
                            /** Format: uuid */
                            tenantId: string;
                            /** Format: date-time */
                            updatedAt: string;
                            version: number;
                        };
                    };
                };
                /** @description Default Response */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                500: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
            };
        };
        trace?: never;
    };
    "/api/v1/tenants/{tenantId}/personal-profiles/{profileId}/expenses/{expenseId}/enrichment-runs": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    expenseId: string;
                    profileId: string;
                    tenantId: string;
                };
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        /** Format: uuid */
                        expenseId: string;
                        kinds: ("tag" | "spending_category" | "tax_category")[];
                    };
                };
            };
            responses: {
                /** @description Default Response */
                204: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Default Response */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                412: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                500: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/tenants/{tenantId}/personal-profiles/{profileId}/expenses/{expenseId}/suggestions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    expenseId: string;
                    profileId: string;
                    tenantId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Default Response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            items: ({
                                businessId: string | null;
                                businessTaxProfileId: null;
                                businessTaxProfileVersion: null;
                                confidence: number;
                                /** Format: date-time */
                                createdAt: string;
                                evidence: {
                                    [key: string]: string | number | boolean | null | (string | number | boolean | null)[];
                                };
                                evidenceHash: string;
                                /** Format: uuid */
                                expenseId: string;
                                expenseVersion: number;
                                /** Format: uuid */
                                id: string;
                                idempotencyKey: string;
                                /** Format: uuid */
                                jobId: string;
                                /** @enum {string} */
                                kind: "tag";
                                personalProfileId: string | null;
                                resolvedAt: string | null;
                                resolvedByUserId: string | null;
                                /** @enum {string} */
                                source: "historical" | "ai";
                                spendingCategoryId: null;
                                /** @enum {string} */
                                status: "pending" | "accepted" | "rejected" | "superseded";
                                /** Format: uuid */
                                tagId: string;
                                taxCategoryDefinitionId: null;
                                taxonomyVersionId: null;
                                taxYear: null;
                                /** Format: uuid */
                                tenantId: string;
                                version: number;
                            } | {
                                businessId: string | null;
                                businessTaxProfileId: null;
                                businessTaxProfileVersion: null;
                                confidence: number;
                                /** Format: date-time */
                                createdAt: string;
                                evidence: {
                                    [key: string]: string | number | boolean | null | (string | number | boolean | null)[];
                                };
                                evidenceHash: string;
                                /** Format: uuid */
                                expenseId: string;
                                expenseVersion: number;
                                /** Format: uuid */
                                id: string;
                                idempotencyKey: string;
                                /** Format: uuid */
                                jobId: string;
                                /** @enum {string} */
                                kind: "spending_category";
                                personalProfileId: string | null;
                                resolvedAt: string | null;
                                resolvedByUserId: string | null;
                                /** @enum {string} */
                                source: "historical" | "ai";
                                /** Format: uuid */
                                spendingCategoryId: string;
                                /** @enum {string} */
                                status: "pending" | "accepted" | "rejected" | "superseded";
                                tagId: null;
                                taxCategoryDefinitionId: null;
                                taxonomyVersionId: null;
                                taxYear: null;
                                /** Format: uuid */
                                tenantId: string;
                                version: number;
                            } | {
                                businessId: string | null;
                                /** Format: uuid */
                                businessTaxProfileId: string;
                                businessTaxProfileVersion: number;
                                confidence: number;
                                /** Format: date-time */
                                createdAt: string;
                                evidence: {
                                    [key: string]: string | number | boolean | null | (string | number | boolean | null)[];
                                };
                                evidenceHash: string;
                                /** Format: uuid */
                                expenseId: string;
                                expenseVersion: number;
                                /** Format: uuid */
                                id: string;
                                idempotencyKey: string;
                                /** Format: uuid */
                                jobId: string;
                                /** @enum {string} */
                                kind: "tax_category";
                                personalProfileId: string | null;
                                resolvedAt: string | null;
                                resolvedByUserId: string | null;
                                /** @enum {string} */
                                source: "historical" | "ai";
                                spendingCategoryId: null;
                                /** @enum {string} */
                                status: "pending" | "accepted" | "rejected" | "superseded";
                                tagId: null;
                                /** Format: uuid */
                                taxCategoryDefinitionId: string;
                                /** Format: uuid */
                                taxonomyVersionId: string;
                                taxYear: number;
                                /** Format: uuid */
                                tenantId: string;
                                version: number;
                            })[];
                            nextCursor: string | null;
                        };
                    };
                };
                /** @description Default Response */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                412: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                500: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/tenants/{tenantId}/personal-profiles/{profileId}/expenses/{expenseId}/suggestions/{suggestionId}/resolve": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    expenseId: string;
                    profileId: string;
                    suggestionId: string;
                    tenantId: string;
                };
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        /** @enum {string} */
                        action: "accepted" | "rejected";
                        expectedExpenseVersion: number;
                        expectedSuggestionVersion: number;
                        idempotencyKey: string;
                        taxAcceptance?: {
                            /** Format: uuid */
                            businessTaxProfileId: string;
                            deductiblePercent: string;
                        };
                    };
                };
            };
            responses: {
                /** @description Default Response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {string} */
                            status: "pending" | "accepted" | "rejected" | "superseded";
                            /** Format: uuid */
                            suggestionId: string;
                            version: number;
                        };
                    };
                };
                /** @description Default Response */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                412: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                500: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/tenants/{tenantId}/personal-profiles/{profileId}/expenses/{expenseId}/tags": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    expenseId: string;
                    profileId: string;
                    tenantId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Default Response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            items: {
                                appliedAt: string | null;
                                appliedByUserId: string | null;
                                businessId: string | null;
                                confidence: number;
                                /** Format: date-time */
                                createdAt: string;
                                /** Format: uuid */
                                expenseId: string;
                                /** Format: uuid */
                                id: string;
                                personalProfileId: string | null;
                                removedAt: string | null;
                                removedByUserId: string | null;
                                ruleVersion: number | null;
                                /** @enum {string} */
                                source: "manual" | "rule" | "historical" | "ai";
                                /** @enum {string} */
                                status: "active" | "removed";
                                suggestionId: string | null;
                                /** Format: uuid */
                                tagId: string;
                                /** Format: uuid */
                                tenantId: string;
                                version: number;
                            }[];
                            nextCursor: string | null;
                        };
                    };
                };
                /** @description Default Response */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                412: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                500: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/tenants/{tenantId}/personal-profiles/{profileId}/expenses/{expenseId}/tags/{tagId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    expenseId: string;
                    profileId: string;
                    tagId: string;
                    tenantId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Default Response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            appliedAt: string | null;
                            appliedByUserId: string | null;
                            businessId: string | null;
                            confidence: number;
                            /** Format: date-time */
                            createdAt: string;
                            /** Format: uuid */
                            expenseId: string;
                            /** Format: uuid */
                            id: string;
                            personalProfileId: string | null;
                            removedAt: string | null;
                            removedByUserId: string | null;
                            ruleVersion: number | null;
                            /** @enum {string} */
                            source: "manual" | "rule" | "historical" | "ai";
                            /** @enum {string} */
                            status: "active" | "removed";
                            suggestionId: string | null;
                            /** Format: uuid */
                            tagId: string;
                            /** Format: uuid */
                            tenantId: string;
                            version: number;
                        };
                    };
                };
                /** @description Default Response */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                412: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                500: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
            };
        };
        post?: never;
        delete: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    expenseId: string;
                    profileId: string;
                    tagId: string;
                    tenantId: string;
                };
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        expectedVersion: number;
                    };
                };
            };
            responses: {
                /** @description Default Response */
                204: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Default Response */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                412: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                500: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
            };
        };
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/tenants/{tenantId}/personal-profiles/{profileId}/files": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: {
            parameters: {
                query?: {
                    cursor?: string;
                    limit?: number;
                };
                header?: never;
                path: {
                    profileId: string;
                    tenantId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Default Response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            items: {
                                businessId: string | null;
                                /** @enum {string} */
                                contentType: "image/jpeg" | "image/png" | "image/webp" | "application/pdf";
                                /** Format: date-time */
                                createdAt: string;
                                expenseId: string | null;
                                /** Format: uuid */
                                id: string;
                                originalFilename: string;
                                personalProfileId: string | null;
                                sha256Hex: string | null;
                                sizeBytes: number | null;
                                /** @enum {string} */
                                status: "PENDING" | "READY" | "FAILED" | "DELETED";
                                storageKey: string;
                                /** Format: uuid */
                                tenantId: string;
                                /** @enum {string} */
                                thumbnailStatus: "pending" | "ready" | "skipped" | "failed";
                                thumbnailStorageKey: string | null;
                                /** Format: date-time */
                                updatedAt: string;
                                version: number;
                            }[];
                            nextCursor: string | null;
                        };
                    };
                };
                /** @description Default Response */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                410: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                413: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                500: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/tenants/{tenantId}/personal-profiles/{profileId}/files/{fileId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    fileId: string;
                    profileId: string;
                    tenantId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Default Response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            businessId: string | null;
                            /** @enum {string} */
                            contentType: "image/jpeg" | "image/png" | "image/webp" | "application/pdf";
                            /** Format: date-time */
                            createdAt: string;
                            expenseId: string | null;
                            /** Format: uuid */
                            id: string;
                            originalFilename: string;
                            personalProfileId: string | null;
                            sha256Hex: string | null;
                            sizeBytes: number | null;
                            /** @enum {string} */
                            status: "PENDING" | "READY" | "FAILED" | "DELETED";
                            storageKey: string;
                            /** Format: uuid */
                            tenantId: string;
                            /** @enum {string} */
                            thumbnailStatus: "pending" | "ready" | "skipped" | "failed";
                            thumbnailStorageKey: string | null;
                            /** Format: date-time */
                            updatedAt: string;
                            version: number;
                        };
                    };
                };
                /** @description Default Response */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                410: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                413: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                500: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    fileId: string;
                    profileId: string;
                    tenantId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Default Response */
                204: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Default Response */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                410: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                413: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                500: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
            };
        };
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/tenants/{tenantId}/personal-profiles/{profileId}/files/{fileId}/ocr-jobs": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    fileId: string;
                    profileId: string;
                    tenantId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Default Response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            items: {
                                allowedResultSchemaVersion: string;
                                businessId: string | null;
                                completedAt: string | null;
                                /** Format: date-time */
                                createdAt: string;
                                dispatchedAt: string | null;
                                errorMessage: string | null;
                                expectedAggregateVersion: number | null;
                                /** Format: uuid */
                                id: string;
                                inputParams: {
                                    [key: string]: unknown;
                                };
                                personalProfileId: string | null;
                                result: {
                                    [key: string]: unknown;
                                } | null;
                                runId: string | null;
                                /** @enum {string} */
                                status: "PENDING" | "DISPATCHED" | "RUNNING" | "SUCCEEDED" | "FAILED";
                                targetAggregateId: string | null;
                                targetAggregateType: string | null;
                                taskQueue: string;
                                /** Format: uuid */
                                tenantId: string;
                                /** Format: date-time */
                                updatedAt: string;
                                version: number;
                                workflowId: string;
                                workflowType: string;
                            }[];
                        };
                    };
                };
                /** @description Default Response */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                412: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                500: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
            };
        };
        put?: never;
        post: {
            parameters: {
                query?: never;
                header: {
                    "idempotency-key": string;
                };
                path: {
                    fileId: string;
                    profileId: string;
                    tenantId: string;
                };
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        /** @enum {string} */
                        modeKey: "ocr_mode_fast" | "ocr_mode_balanced" | "ocr_mode_accurate";
                    };
                };
            };
            responses: {
                /** @description Default Response */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            allowedResultSchemaVersion: string;
                            businessId: string | null;
                            completedAt: string | null;
                            /** Format: date-time */
                            createdAt: string;
                            dispatchedAt: string | null;
                            errorMessage: string | null;
                            expectedAggregateVersion: number | null;
                            /** Format: uuid */
                            id: string;
                            inputParams: {
                                [key: string]: unknown;
                            };
                            personalProfileId: string | null;
                            result: {
                                [key: string]: unknown;
                            } | null;
                            runId: string | null;
                            /** @enum {string} */
                            status: "PENDING" | "DISPATCHED" | "RUNNING" | "SUCCEEDED" | "FAILED";
                            targetAggregateId: string | null;
                            targetAggregateType: string | null;
                            taskQueue: string;
                            /** Format: uuid */
                            tenantId: string;
                            /** Format: date-time */
                            updatedAt: string;
                            version: number;
                            workflowId: string;
                            workflowType: string;
                        };
                    };
                };
                /** @description Default Response */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                412: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                500: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/tenants/{tenantId}/personal-profiles/{profileId}/files/{fileId}/read-url": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    fileId: string;
                    profileId: string;
                    tenantId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Default Response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** Format: date-time */
                            expiresAt: string;
                            url: string;
                        };
                    };
                };
                /** @description Default Response */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                410: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                413: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                500: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/tenants/{tenantId}/personal-profiles/{profileId}/files/upload-sessions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header: {
                    "idempotency-key": string;
                };
                path: {
                    profileId: string;
                    tenantId: string;
                };
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        /** @enum {string} */
                        contentType: "image/jpeg" | "image/png" | "image/webp" | "application/pdf";
                        expectedSizeBytes?: number;
                        /** Format: uuid */
                        expenseId?: string;
                        originalFilename: string;
                    };
                };
            };
            responses: {
                /** @description Default Response */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            file: {
                                businessId: string | null;
                                /** @enum {string} */
                                contentType: "image/jpeg" | "image/png" | "image/webp" | "application/pdf";
                                /** Format: date-time */
                                createdAt: string;
                                expenseId: string | null;
                                /** Format: uuid */
                                id: string;
                                originalFilename: string;
                                personalProfileId: string | null;
                                sha256Hex: string | null;
                                sizeBytes: number | null;
                                /** @enum {string} */
                                status: "PENDING" | "READY" | "FAILED" | "DELETED";
                                storageKey: string;
                                /** Format: uuid */
                                tenantId: string;
                                /** @enum {string} */
                                thumbnailStatus: "pending" | "ready" | "skipped" | "failed";
                                thumbnailStorageKey: string | null;
                                /** Format: date-time */
                                updatedAt: string;
                                version: number;
                            };
                            uploadSession: {
                                confirmedAt: string | null;
                                /** Format: date-time */
                                createdAt: string;
                                /** Format: uuid */
                                expenseFileId: string;
                                /** Format: date-time */
                                expiresAt: string;
                                /** Format: uuid */
                                id: string;
                                /** @enum {string} */
                                status: "PENDING" | "CONFIRMED" | "EXPIRED";
                            };
                            uploadTarget: {
                                /** Format: date-time */
                                expiresAt: string;
                                /** @enum {string} */
                                method: "PUT";
                                requiredHeaders: {
                                    [key: string]: string;
                                };
                                url: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                410: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                413: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                500: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/tenants/{tenantId}/personal-profiles/{profileId}/files/upload-sessions/{sessionId}/confirm": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    profileId: string;
                    sessionId: string;
                    tenantId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Default Response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            businessId: string | null;
                            /** @enum {string} */
                            contentType: "image/jpeg" | "image/png" | "image/webp" | "application/pdf";
                            /** Format: date-time */
                            createdAt: string;
                            expenseId: string | null;
                            /** Format: uuid */
                            id: string;
                            originalFilename: string;
                            personalProfileId: string | null;
                            sha256Hex: string | null;
                            sizeBytes: number | null;
                            /** @enum {string} */
                            status: "PENDING" | "READY" | "FAILED" | "DELETED";
                            storageKey: string;
                            /** Format: uuid */
                            tenantId: string;
                            /** @enum {string} */
                            thumbnailStatus: "pending" | "ready" | "skipped" | "failed";
                            thumbnailStorageKey: string | null;
                            /** Format: date-time */
                            updatedAt: string;
                            version: number;
                        };
                    };
                };
                /** @description Default Response */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                410: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                413: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                500: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/tenants/{tenantId}/personal-profiles/{profileId}/forwarding/inbound-emails": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    profileId: string;
                    tenantId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Default Response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            items: {
                                attachmentCount: number;
                                businessId: string | null;
                                /** Format: date-time */
                                createdAt: string;
                                /** Format: uuid */
                                id: string;
                                personalProfileId: string | null;
                                processedAt: string | null;
                                providerMessageId: string;
                                quarantineReason: ("UNKNOWN_TOKEN" | "TOKEN_REVOKED" | "SENDER_NOT_VERIFIED" | "SENDER_MISMATCH" | "EMAIL_AUTH_FAILED" | "NO_ATTACHMENTS" | "TOO_MANY_ATTACHMENTS" | "MESSAGE_TOO_LARGE" | "UNSUPPORTED_ATTACHMENT" | "INVALID_ATTACHMENT" | "MALWARE_DETECTED" | "RATE_LIMITED" | "DUPLICATE" | "ENTITLEMENT_DISABLED" | "PROCESSING_FAILED") | null;
                                recipientAddress: string;
                                senderEmail: string;
                                /** @enum {string} */
                                status: "ACCEPTED" | "QUARANTINED" | "DISMISSED";
                                subject: string | null;
                                tenantId: string | null;
                                totalBytes: number;
                            }[];
                        };
                    };
                };
                /** @description Default Response */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                500: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/tenants/{tenantId}/personal-profiles/{profileId}/forwarding/quarantine": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    profileId: string;
                    tenantId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Default Response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            items: {
                                attachmentCount: number;
                                businessId: string | null;
                                /** Format: date-time */
                                createdAt: string;
                                /** Format: uuid */
                                id: string;
                                personalProfileId: string | null;
                                processedAt: string | null;
                                providerMessageId: string;
                                quarantineReason: ("UNKNOWN_TOKEN" | "TOKEN_REVOKED" | "SENDER_NOT_VERIFIED" | "SENDER_MISMATCH" | "EMAIL_AUTH_FAILED" | "NO_ATTACHMENTS" | "TOO_MANY_ATTACHMENTS" | "MESSAGE_TOO_LARGE" | "UNSUPPORTED_ATTACHMENT" | "INVALID_ATTACHMENT" | "MALWARE_DETECTED" | "RATE_LIMITED" | "DUPLICATE" | "ENTITLEMENT_DISABLED" | "PROCESSING_FAILED") | null;
                                recipientAddress: string;
                                senderEmail: string;
                                /** @enum {string} */
                                status: "ACCEPTED" | "QUARANTINED" | "DISMISSED";
                                subject: string | null;
                                tenantId: string | null;
                                totalBytes: number;
                            }[];
                        };
                    };
                };
                /** @description Default Response */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                500: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/tenants/{tenantId}/personal-profiles/{profileId}/forwarding/quarantine/{inboundEmailId}/dismiss": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    inboundEmailId: string;
                    profileId: string;
                    tenantId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Default Response */
                204: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Default Response */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                500: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/tenants/{tenantId}/personal-profiles/{profileId}/forwarding/routing-token": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    profileId: string;
                    tenantId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Default Response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            businessId: string | null;
                            /** Format: date-time */
                            createdAt: string;
                            /** Format: uuid */
                            id: string;
                            personalProfileId: string | null;
                            revokedAt: string | null;
                            /** Format: email */
                            routingAddress: string;
                            /** @enum {string} */
                            status: "active" | "revoked";
                            /** Format: uuid */
                            tenantId: string;
                        };
                    };
                };
                /** @description Default Response */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                500: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
            };
        };
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    profileId: string;
                    tenantId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Default Response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            businessId: string | null;
                            /** Format: date-time */
                            createdAt: string;
                            /** Format: uuid */
                            id: string;
                            personalProfileId: string | null;
                            revokedAt: string | null;
                            /** Format: email */
                            routingAddress: string;
                            /** @enum {string} */
                            status: "active" | "revoked";
                            /** Format: uuid */
                            tenantId: string;
                        };
                    };
                };
                /** @description Default Response */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                500: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/tenants/{tenantId}/personal-profiles/{profileId}/forwarding/verified-senders": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    profileId: string;
                    tenantId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Default Response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            items: {
                                businessId: string | null;
                                /** Format: date-time */
                                createdAt: string;
                                /** Format: email */
                                email: string;
                                /** Format: uuid */
                                id: string;
                                personalProfileId: string | null;
                                /** @enum {string} */
                                status: "pending" | "verified" | "revoked";
                                /** Format: uuid */
                                tenantId: string;
                                verifiedAt: string | null;
                            }[];
                        };
                    };
                };
                /** @description Default Response */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                500: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
            };
        };
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    profileId: string;
                    tenantId: string;
                };
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        /** Format: email */
                        email: string;
                    };
                };
            };
            responses: {
                /** @description Default Response */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            businessId: string | null;
                            /** Format: date-time */
                            createdAt: string;
                            /** Format: email */
                            email: string;
                            /** Format: uuid */
                            id: string;
                            personalProfileId: string | null;
                            /** @enum {string} */
                            status: "pending" | "verified" | "revoked";
                            /** Format: uuid */
                            tenantId: string;
                            verifiedAt: string | null;
                        };
                    };
                };
                /** @description Default Response */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                500: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/tenants/{tenantId}/personal-profiles/{profileId}/forwarding/verified-senders/{senderId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        delete: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    profileId: string;
                    senderId: string;
                    tenantId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Default Response */
                204: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Default Response */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                500: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
            };
        };
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/tenants/{tenantId}/personal-profiles/{profileId}/forwarding/verified-senders/{senderId}/verify": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    profileId: string;
                    senderId: string;
                    tenantId: string;
                };
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        verificationToken: string;
                    };
                };
            };
            responses: {
                /** @description Default Response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            businessId: string | null;
                            /** Format: date-time */
                            createdAt: string;
                            /** Format: email */
                            email: string;
                            /** Format: uuid */
                            id: string;
                            personalProfileId: string | null;
                            /** @enum {string} */
                            status: "pending" | "verified" | "revoked";
                            /** Format: uuid */
                            tenantId: string;
                            verifiedAt: string | null;
                        };
                    };
                };
                /** @description Default Response */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                500: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/tenants/{tenantId}/personal-profiles/{profileId}/memberships": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    profileId: string;
                    tenantId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Default Response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            items: {
                                /** Format: date-time */
                                createdAt: string;
                                /** Format: uuid */
                                personalProfileId: string;
                                /** @enum {string} */
                                role: "owner" | "editor" | "viewer";
                                /** @enum {string} */
                                status: "active" | "inactive";
                                /** Format: uuid */
                                tenantId: string;
                                /** Format: date-time */
                                updatedAt: string;
                                /** Format: uuid */
                                userId: string;
                                version: number;
                            }[];
                        };
                    };
                };
                /** @description Default Response */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                500: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
            };
        };
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    profileId: string;
                    tenantId: string;
                };
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        /** @enum {string} */
                        role: "owner" | "editor" | "viewer";
                        /** Format: uuid */
                        userId: string;
                    };
                };
            };
            responses: {
                /** @description Default Response */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** Format: date-time */
                            createdAt: string;
                            /** Format: uuid */
                            personalProfileId: string;
                            /** @enum {string} */
                            role: "owner" | "editor" | "viewer";
                            /** @enum {string} */
                            status: "active" | "inactive";
                            /** Format: uuid */
                            tenantId: string;
                            /** Format: date-time */
                            updatedAt: string;
                            /** Format: uuid */
                            userId: string;
                            version: number;
                        };
                    };
                };
                /** @description Default Response */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                500: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/tenants/{tenantId}/personal-profiles/{profileId}/memberships/{userId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    profileId: string;
                    tenantId: string;
                    userId: string;
                };
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        expectedVersion: number;
                        /** @enum {string} */
                        role?: "owner" | "editor" | "viewer";
                        /** @enum {string} */
                        status?: "active" | "inactive";
                    };
                };
            };
            responses: {
                /** @description Default Response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** Format: date-time */
                            createdAt: string;
                            /** Format: uuid */
                            personalProfileId: string;
                            /** @enum {string} */
                            role: "owner" | "editor" | "viewer";
                            /** @enum {string} */
                            status: "active" | "inactive";
                            /** Format: uuid */
                            tenantId: string;
                            /** Format: date-time */
                            updatedAt: string;
                            /** Format: uuid */
                            userId: string;
                            version: number;
                        };
                    };
                };
                /** @description Default Response */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                500: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
            };
        };
        trace?: never;
    };
    "/api/v1/tenants/{tenantId}/personal-profiles/mine": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    tenantId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Default Response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            profile: {
                                /** Format: uuid */
                                id: string;
                                name: string;
                            } | null;
                        };
                    };
                };
                /** @description Default Response */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                500: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/tenants/{tenantId}/spending-categories": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    tenantId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Default Response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            items: {
                                color: string;
                                /** Format: date-time */
                                createdAt: string;
                                description: string | null;
                                icon: string;
                                /** Format: uuid */
                                id: string;
                                name: string;
                                /** @enum {string} */
                                status: "active" | "archived";
                                templateKey: string | null;
                                /** Format: uuid */
                                tenantId: string;
                                /** Format: date-time */
                                updatedAt: string;
                                version: number;
                            }[];
                        };
                    };
                };
                /** @description Default Response */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                500: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
            };
        };
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    tenantId: string;
                };
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        color: string;
                        description?: string | null;
                        icon: string;
                        name: string;
                    };
                };
            };
            responses: {
                /** @description Default Response */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            color: string;
                            /** Format: date-time */
                            createdAt: string;
                            description: string | null;
                            icon: string;
                            /** Format: uuid */
                            id: string;
                            name: string;
                            /** @enum {string} */
                            status: "active" | "archived";
                            templateKey: string | null;
                            /** Format: uuid */
                            tenantId: string;
                            /** Format: date-time */
                            updatedAt: string;
                            version: number;
                        };
                    };
                };
                /** @description Default Response */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                500: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/tenants/{tenantId}/spending-categories/{categoryId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        delete: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    categoryId: string;
                    tenantId: string;
                };
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        expectedVersion: number;
                    };
                };
            };
            responses: {
                /** @description Default Response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            color: string;
                            /** Format: date-time */
                            createdAt: string;
                            description: string | null;
                            icon: string;
                            /** Format: uuid */
                            id: string;
                            name: string;
                            /** @enum {string} */
                            status: "active" | "archived";
                            templateKey: string | null;
                            /** Format: uuid */
                            tenantId: string;
                            /** Format: date-time */
                            updatedAt: string;
                            version: number;
                        };
                    };
                };
                /** @description Default Response */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                500: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
            };
        };
        options?: never;
        head?: never;
        patch: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    categoryId: string;
                    tenantId: string;
                };
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        color?: string;
                        description?: string | null;
                        expectedVersion: number;
                        icon?: string;
                        name?: string;
                    };
                };
            };
            responses: {
                /** @description Default Response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            color: string;
                            /** Format: date-time */
                            createdAt: string;
                            description: string | null;
                            icon: string;
                            /** Format: uuid */
                            id: string;
                            name: string;
                            /** @enum {string} */
                            status: "active" | "archived";
                            templateKey: string | null;
                            /** Format: uuid */
                            tenantId: string;
                            /** Format: date-time */
                            updatedAt: string;
                            version: number;
                        };
                    };
                };
                /** @description Default Response */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                500: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
            };
        };
        trace?: never;
    };
    "/api/v1/tenants/{tenantId}/subscription": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    tenantId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Default Response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            currentEntitlementVersion: number;
                            planKey: string;
                            /** Format: uuid */
                            planVersionId: string;
                            /** Format: date-time */
                            startedAt: string;
                            /** @enum {string} */
                            status: "trialing" | "active" | "canceled";
                            /** Format: uuid */
                            tenantId: string;
                            /** Format: date-time */
                            updatedAt: string;
                            version: number;
                        };
                    };
                };
                /** @description Default Response */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                500: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
            };
        };
        put: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    tenantId: string;
                };
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        planKey: string;
                    };
                };
            };
            responses: {
                /** @description Default Response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            currentEntitlementVersion: number;
                            planKey: string;
                            /** Format: uuid */
                            planVersionId: string;
                            /** Format: date-time */
                            startedAt: string;
                            /** @enum {string} */
                            status: "trialing" | "active" | "canceled";
                            /** Format: uuid */
                            tenantId: string;
                            /** Format: date-time */
                            updatedAt: string;
                            version: number;
                        };
                    };
                };
                /** @description Default Response */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                500: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
            };
        };
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/tenants/{tenantId}/tags": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    tenantId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Default Response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            items: {
                                color: string | null;
                                /** Format: date-time */
                                createdAt: string;
                                createdByUserId: string | null;
                                /** Format: uuid */
                                id: string;
                                key: string;
                                name: string;
                                /** @enum {string} */
                                origin: "custom" | "rule";
                                /** @enum {string} */
                                status: "active" | "archived";
                                /** Format: uuid */
                                tenantId: string;
                                /** Format: date-time */
                                updatedAt: string;
                                version: number;
                            }[];
                            nextCursor: string | null;
                        };
                    };
                };
                /** @description Default Response */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                412: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                500: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
            };
        };
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    tenantId: string;
                };
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        color?: string | null;
                        name: string;
                    };
                };
            };
            responses: {
                /** @description Default Response */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            color: string | null;
                            /** Format: date-time */
                            createdAt: string;
                            createdByUserId: string | null;
                            /** Format: uuid */
                            id: string;
                            key: string;
                            name: string;
                            /** @enum {string} */
                            origin: "custom" | "rule";
                            /** @enum {string} */
                            status: "active" | "archived";
                            /** Format: uuid */
                            tenantId: string;
                            /** Format: date-time */
                            updatedAt: string;
                            version: number;
                        };
                    };
                };
                /** @description Default Response */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                412: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                500: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/tenants/{tenantId}/tags/{tagId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        delete: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    tagId: string;
                    tenantId: string;
                };
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        expectedVersion: number;
                    };
                };
            };
            responses: {
                /** @description Default Response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            color: string | null;
                            /** Format: date-time */
                            createdAt: string;
                            createdByUserId: string | null;
                            /** Format: uuid */
                            id: string;
                            key: string;
                            name: string;
                            /** @enum {string} */
                            origin: "custom" | "rule";
                            /** @enum {string} */
                            status: "active" | "archived";
                            /** Format: uuid */
                            tenantId: string;
                            /** Format: date-time */
                            updatedAt: string;
                            version: number;
                        };
                    };
                };
                /** @description Default Response */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                412: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                500: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
            };
        };
        options?: never;
        head?: never;
        patch: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    tagId: string;
                    tenantId: string;
                };
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        color?: string | null;
                        expectedVersion: number;
                        name?: string;
                    };
                };
            };
            responses: {
                /** @description Default Response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            color: string | null;
                            /** Format: date-time */
                            createdAt: string;
                            createdByUserId: string | null;
                            /** Format: uuid */
                            id: string;
                            key: string;
                            name: string;
                            /** @enum {string} */
                            origin: "custom" | "rule";
                            /** @enum {string} */
                            status: "active" | "archived";
                            /** Format: uuid */
                            tenantId: string;
                            /** Format: date-time */
                            updatedAt: string;
                            version: number;
                        };
                    };
                };
                /** @description Default Response */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                412: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                500: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
            };
        };
        trace?: never;
    };
    "/api/v1/tenants/{tenantId}/tags/{tagId}/merge": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    tagId: string;
                    tenantId: string;
                };
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        expectedSourceVersion: number;
                        expectedTargetVersion: number;
                        /** Format: uuid */
                        sourceTagId: string;
                        /** Format: uuid */
                        targetTagId: string;
                    };
                };
            };
            responses: {
                /** @description Default Response */
                204: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Default Response */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                412: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                500: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/tenants/{tenantId}/tags/{tagId}/unarchive": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    tagId: string;
                    tenantId: string;
                };
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        expectedVersion: number;
                    };
                };
            };
            responses: {
                /** @description Default Response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            color: string | null;
                            /** Format: date-time */
                            createdAt: string;
                            createdByUserId: string | null;
                            /** Format: uuid */
                            id: string;
                            key: string;
                            name: string;
                            /** @enum {string} */
                            origin: "custom" | "rule";
                            /** @enum {string} */
                            status: "active" | "archived";
                            /** Format: uuid */
                            tenantId: string;
                            /** Format: date-time */
                            updatedAt: string;
                            version: number;
                        };
                    };
                };
                /** @description Default Response */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                412: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                500: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/users/me": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Default Response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            user: {
                                displayName: string;
                                /** Format: uuid */
                                id: string;
                                /** Format: email */
                                primaryEmail: string;
                                /** @enum {string} */
                                status: "active" | "disabled";
                            };
                        };
                    };
                };
                /** @description Default Response */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                500: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/health/live": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Default Response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {string} */
                            service: "app-api" | "foundry-service";
                            /** @enum {string} */
                            status: "ok" | "degraded";
                            version: string;
                        };
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/health/ready": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Default Response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @enum {string} */
                            service: "app-api" | "foundry-service";
                            /** @enum {string} */
                            status: "ok" | "degraded";
                            version: string;
                        };
                    };
                };
                /** @description Default Response */
                503: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/internal/v1/entitlement-snapshots": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: {
            parameters: {
                query?: {
                    afterSequence?: number;
                    limit?: number;
                };
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Default Response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            items: {
                                entitlements: {
                                    /** @enum {string} */
                                    featureKey: "receipt_forwarding" | "connected_mailbox_scan" | "ai_search" | "ocr_mode_fast" | "ocr_mode_balanced" | "ocr_mode_accurate";
                                    isEnabled: boolean;
                                    limitPeriod: ("monthly" | "unlimited") | null;
                                    limitValue: number | null;
                                    /** @enum {string} */
                                    source: "plan" | "addon" | "override";
                                }[];
                                entitlementVersion: number;
                                /** Format: uuid */
                                tenantId: string;
                            }[];
                            nextAfterSequence: number | null;
                        };
                    };
                };
                /** @description Default Response */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                500: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/internal/v1/feature-definitions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        description?: string | null;
                        /** @enum {string} */
                        key: "receipt_forwarding" | "connected_mailbox_scan" | "ai_search" | "ocr_mode_fast" | "ocr_mode_balanced" | "ocr_mode_accurate";
                        name: string;
                    };
                };
            };
            responses: {
                /** @description Default Response */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** Format: date-time */
                            createdAt: string;
                            description: string | null;
                            /** Format: uuid */
                            id: string;
                            /** @enum {string} */
                            key: "receipt_forwarding" | "connected_mailbox_scan" | "ai_search" | "ocr_mode_fast" | "ocr_mode_balanced" | "ocr_mode_accurate";
                            name: string;
                        };
                    };
                };
                /** @description Default Response */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                500: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/internal/v1/files/{fileId}/read-url": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    fileId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Default Response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** Format: date-time */
                            expiresAt: string;
                            url: string;
                        };
                    };
                };
                /** @description Default Response */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                410: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                413: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                500: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/internal/v1/identity-provisionings": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        displayName: string;
                        email: string;
                        /** @enum {boolean} */
                        emailVerified: true;
                        /** Format: uri */
                        issuer: string;
                        subject: string;
                    };
                };
            };
            responses: {
                /** @description Default Response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            user: {
                                /** Format: date-time */
                                createdAt: string;
                                displayName: string;
                                /** Format: uuid */
                                id: string;
                                /** Format: email */
                                primaryEmail: string;
                                /** @enum {string} */
                                status: "active" | "disabled";
                                /** Format: date-time */
                                updatedAt: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            user: {
                                /** Format: date-time */
                                createdAt: string;
                                displayName: string;
                                /** Format: uuid */
                                id: string;
                                /** Format: email */
                                primaryEmail: string;
                                /** @enum {string} */
                                status: "active" | "disabled";
                                /** Format: date-time */
                                updatedAt: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                500: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/internal/v1/inbound-email/provider-webhook": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header: {
                    "x-inbound-signature": string;
                };
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Default Response */
                202: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            createdFileIds: string[];
                            createdJobIds: string[];
                            inboundEmail: {
                                attachmentCount: number;
                                businessId: string | null;
                                /** Format: date-time */
                                createdAt: string;
                                /** Format: uuid */
                                id: string;
                                personalProfileId: string | null;
                                processedAt: string | null;
                                providerMessageId: string;
                                quarantineReason: ("UNKNOWN_TOKEN" | "TOKEN_REVOKED" | "SENDER_NOT_VERIFIED" | "SENDER_MISMATCH" | "EMAIL_AUTH_FAILED" | "NO_ATTACHMENTS" | "TOO_MANY_ATTACHMENTS" | "MESSAGE_TOO_LARGE" | "UNSUPPORTED_ATTACHMENT" | "INVALID_ATTACHMENT" | "MALWARE_DETECTED" | "RATE_LIMITED" | "DUPLICATE" | "ENTITLEMENT_DISABLED" | "PROCESSING_FAILED") | null;
                                recipientAddress: string;
                                senderEmail: string;
                                /** @enum {string} */
                                status: "ACCEPTED" | "QUARANTINED" | "DISMISSED";
                                subject: string | null;
                                tenantId: string | null;
                                totalBytes: number;
                            };
                        };
                    };
                };
                /** @description Default Response */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                500: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/internal/v1/jobs/{jobId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    jobId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Default Response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            allowedResultSchemaVersion: string;
                            businessId: string | null;
                            completedAt: string | null;
                            /** Format: date-time */
                            createdAt: string;
                            dispatchedAt: string | null;
                            errorMessage: string | null;
                            expectedAggregateVersion: number | null;
                            /** Format: uuid */
                            id: string;
                            inputParams: {
                                [key: string]: unknown;
                            };
                            personalProfileId: string | null;
                            result: {
                                [key: string]: unknown;
                            } | null;
                            runId: string | null;
                            /** @enum {string} */
                            status: "PENDING" | "DISPATCHED" | "RUNNING" | "SUCCEEDED" | "FAILED";
                            targetAggregateId: string | null;
                            targetAggregateType: string | null;
                            taskQueue: string;
                            /** Format: uuid */
                            tenantId: string;
                            /** Format: date-time */
                            updatedAt: string;
                            version: number;
                            workflowId: string;
                            workflowType: string;
                        };
                    };
                };
                /** @description Default Response */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                412: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                500: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/internal/v1/jobs/{jobId}/enrichment-input": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    jobId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Default Response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            input: {
                                eligibleSpendingCategoryIds: string[];
                                eligibleTagKeys: string[];
                                eligibleTaxSnapshot: {
                                    activeTaxCategoryIds: string[];
                                    /** Format: uuid */
                                    businessTaxProfileId: string;
                                    businessTaxProfileVersion: number;
                                    /** Format: uuid */
                                    taxonomyVersionId: string;
                                    taxYear: number;
                                } | null;
                                /** Format: uuid */
                                expenseId: string;
                                expenseVersion: number;
                                history: {
                                    candidateSpendingCategoryIds: {
                                        count: number;
                                        /** Format: uuid */
                                        id: string;
                                    }[];
                                    candidateTagKeys: {
                                        count: number;
                                        key: string;
                                    }[];
                                    candidateTaxCategoryIds: {
                                        count: number;
                                        /** Format: uuid */
                                        id: string;
                                    }[];
                                    exampleCount: number;
                                };
                                incurredOn: string;
                                /** Format: uuid */
                                jobId: string;
                                normalizedMerchant: string | null;
                                rulesVersion: number;
                                /** @enum {number} */
                                schemaVersion: 1;
                                spendingCategoryId: string | null;
                            };
                            /** @enum {string} */
                            outcome: "evaluate";
                        } | {
                            /** @enum {string} */
                            outcome: "stale";
                        } | {
                            /** @enum {string} */
                            outcome: "skipped";
                        };
                    };
                };
                /** @description Default Response */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                412: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                500: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/internal/v1/jobs/{jobId}/enrichment-result": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    jobId: string;
                };
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        expectedJobVersion: number;
                        idempotencyKey: string;
                        result: {
                            /** @enum {string} */
                            outcome: "applied" | "stale" | "skipped";
                            rulesVersion: number;
                            ruleTagKeys: string[];
                            /** @enum {number} */
                            schemaVersion: 1;
                            suggestions: ({
                                aggregateCounts: {
                                    exampleCount: number;
                                    matchCount: number;
                                };
                                confidence: number;
                                evidenceHash: string;
                                /** @enum {string} */
                                kind: "tag";
                                /** @enum {string} */
                                source: "historical";
                                tagKey: string;
                            } | {
                                aggregateCounts: {
                                    exampleCount: number;
                                    matchCount: number;
                                };
                                confidence: number;
                                evidenceHash: string;
                                /** @enum {string} */
                                kind: "spending_category";
                                /** @enum {string} */
                                source: "historical";
                                /** Format: uuid */
                                spendingCategoryId: string;
                            } | {
                                aggregateCounts: {
                                    exampleCount: number;
                                    matchCount: number;
                                };
                                /** Format: uuid */
                                businessTaxProfileId: string;
                                businessTaxProfileVersion: number;
                                confidence: number;
                                evidenceHash: string;
                                expenseVersion: number;
                                /** @enum {string} */
                                kind: "tax_category";
                                /** @enum {string} */
                                source: "historical";
                                /** Format: uuid */
                                taxCategoryDefinitionId: string;
                                /** Format: uuid */
                                taxonomyVersionId: string;
                                taxYear: number;
                            })[];
                        };
                        /** @enum {number} */
                        schemaVersion: 1;
                    };
                };
            };
            responses: {
                /** @description Default Response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            allowedResultSchemaVersion: string;
                            businessId: string | null;
                            completedAt: string | null;
                            /** Format: date-time */
                            createdAt: string;
                            dispatchedAt: string | null;
                            errorMessage: string | null;
                            expectedAggregateVersion: number | null;
                            /** Format: uuid */
                            id: string;
                            inputParams: {
                                [key: string]: unknown;
                            };
                            personalProfileId: string | null;
                            result: {
                                [key: string]: unknown;
                            } | null;
                            runId: string | null;
                            /** @enum {string} */
                            status: "PENDING" | "DISPATCHED" | "RUNNING" | "SUCCEEDED" | "FAILED";
                            targetAggregateId: string | null;
                            targetAggregateType: string | null;
                            taskQueue: string;
                            /** Format: uuid */
                            tenantId: string;
                            /** Format: date-time */
                            updatedAt: string;
                            version: number;
                            workflowId: string;
                            workflowType: string;
                        };
                    };
                };
                /** @description Default Response */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                412: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                500: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/internal/v1/jobs/{jobId}/ocr-input": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    jobId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Default Response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            expectedSha256: string | null;
                            /** Format: uuid */
                            fileId: string;
                            /** @enum {string} */
                            modeKey: "ocr_mode_fast" | "ocr_mode_balanced" | "ocr_mode_accurate";
                            /** @enum {number} */
                            schemaVersion: 1;
                            /** Format: uuid */
                            tenantId: string;
                        };
                    };
                };
                /** @description Default Response */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                412: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                500: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/internal/v1/jobs/{jobId}/result": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    jobId: string;
                };
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        expectedJobVersion: number;
                        idempotencyKey: string;
                        message?: string;
                        result: {
                            [key: string]: unknown;
                        };
                        resultSchemaVersion: string;
                        /** @enum {number} */
                        schemaVersion: 1;
                        /** @enum {string} */
                        status: "SUCCEEDED" | "FAILED";
                    };
                };
            };
            responses: {
                /** @description Default Response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            allowedResultSchemaVersion: string;
                            businessId: string | null;
                            completedAt: string | null;
                            /** Format: date-time */
                            createdAt: string;
                            dispatchedAt: string | null;
                            errorMessage: string | null;
                            expectedAggregateVersion: number | null;
                            /** Format: uuid */
                            id: string;
                            inputParams: {
                                [key: string]: unknown;
                            };
                            personalProfileId: string | null;
                            result: {
                                [key: string]: unknown;
                            } | null;
                            runId: string | null;
                            /** @enum {string} */
                            status: "PENDING" | "DISPATCHED" | "RUNNING" | "SUCCEEDED" | "FAILED";
                            targetAggregateId: string | null;
                            targetAggregateType: string | null;
                            taskQueue: string;
                            /** Format: uuid */
                            tenantId: string;
                            /** Format: date-time */
                            updatedAt: string;
                            version: number;
                            workflowId: string;
                            workflowType: string;
                        };
                    };
                };
                /** @description Default Response */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                412: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                500: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/internal/v1/jobs/{jobId}/status": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    jobId: string;
                };
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        expectedJobVersion: number;
                        idempotencyKey: string;
                        message?: string;
                        /** @enum {number} */
                        schemaVersion: 1;
                        /** @enum {string} */
                        status: "RUNNING" | "FAILED";
                    };
                };
            };
            responses: {
                /** @description Default Response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            allowedResultSchemaVersion: string;
                            businessId: string | null;
                            completedAt: string | null;
                            /** Format: date-time */
                            createdAt: string;
                            dispatchedAt: string | null;
                            errorMessage: string | null;
                            expectedAggregateVersion: number | null;
                            /** Format: uuid */
                            id: string;
                            inputParams: {
                                [key: string]: unknown;
                            };
                            personalProfileId: string | null;
                            result: {
                                [key: string]: unknown;
                            } | null;
                            runId: string | null;
                            /** @enum {string} */
                            status: "PENDING" | "DISPATCHED" | "RUNNING" | "SUCCEEDED" | "FAILED";
                            targetAggregateId: string | null;
                            targetAggregateType: string | null;
                            taskQueue: string;
                            /** Format: uuid */
                            tenantId: string;
                            /** Format: date-time */
                            updatedAt: string;
                            version: number;
                            workflowId: string;
                            workflowType: string;
                        };
                    };
                };
                /** @description Default Response */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                412: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                500: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/internal/v1/jobs/dispatch": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Default Response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            dispatchedCount: number;
                        };
                    };
                };
                /** @description Default Response */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                412: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                500: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/internal/v1/jobs/foundation-echo": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        /** Format: uuid */
                        businessId?: string;
                        /** Format: uuid */
                        personalProfileId?: string;
                        /** Format: uuid */
                        tenantId: string;
                    };
                };
            };
            responses: {
                /** @description Default Response */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            allowedResultSchemaVersion: string;
                            businessId: string | null;
                            completedAt: string | null;
                            /** Format: date-time */
                            createdAt: string;
                            dispatchedAt: string | null;
                            errorMessage: string | null;
                            expectedAggregateVersion: number | null;
                            /** Format: uuid */
                            id: string;
                            inputParams: {
                                [key: string]: unknown;
                            };
                            personalProfileId: string | null;
                            result: {
                                [key: string]: unknown;
                            } | null;
                            runId: string | null;
                            /** @enum {string} */
                            status: "PENDING" | "DISPATCHED" | "RUNNING" | "SUCCEEDED" | "FAILED";
                            targetAggregateId: string | null;
                            targetAggregateType: string | null;
                            taskQueue: string;
                            /** Format: uuid */
                            tenantId: string;
                            /** Format: date-time */
                            updatedAt: string;
                            version: number;
                            workflowId: string;
                            workflowType: string;
                        };
                    };
                };
                /** @description Default Response */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                412: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                500: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/internal/v1/plans": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Default Response */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            items: {
                                /** Format: date-time */
                                createdAt: string;
                                description: string | null;
                                /** Format: uuid */
                                id: string;
                                isActive: boolean;
                                key: string;
                                name: string;
                                /** Format: date-time */
                                updatedAt: string;
                                versions: {
                                    /** Format: date-time */
                                    createdAt: string;
                                    /** Format: date-time */
                                    effectiveAt: string;
                                    entitlements: {
                                        /** @enum {string} */
                                        featureKey: "receipt_forwarding" | "connected_mailbox_scan" | "ai_search" | "ocr_mode_fast" | "ocr_mode_balanced" | "ocr_mode_accurate";
                                        isEnabled: boolean;
                                        limitPeriod: ("monthly" | "unlimited") | null;
                                        limitValue: number | null;
                                    }[];
                                    /** Format: uuid */
                                    id: string;
                                    isCurrent: boolean;
                                    /** Format: uuid */
                                    planId: string;
                                    versionNumber: number;
                                }[];
                            }[];
                        };
                    };
                };
                /** @description Default Response */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                500: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
            };
        };
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        description?: string | null;
                        key: string;
                        name: string;
                    };
                };
            };
            responses: {
                /** @description Default Response */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** Format: date-time */
                            createdAt: string;
                            description: string | null;
                            /** Format: uuid */
                            id: string;
                            isActive: boolean;
                            key: string;
                            name: string;
                            /** Format: date-time */
                            updatedAt: string;
                        };
                    };
                };
                /** @description Default Response */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                500: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/internal/v1/plans/{planId}/versions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    planId: string;
                };
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        entitlements: {
                            /** @enum {string} */
                            featureKey: "receipt_forwarding" | "connected_mailbox_scan" | "ai_search" | "ocr_mode_fast" | "ocr_mode_balanced" | "ocr_mode_accurate";
                            isEnabled: boolean;
                            limitPeriod: ("monthly" | "unlimited") | null;
                            limitValue: number | null;
                        }[];
                    };
                };
            };
            responses: {
                /** @description Default Response */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** Format: date-time */
                            createdAt: string;
                            /** Format: date-time */
                            effectiveAt: string;
                            entitlements: {
                                /** @enum {string} */
                                featureKey: "receipt_forwarding" | "connected_mailbox_scan" | "ai_search" | "ocr_mode_fast" | "ocr_mode_balanced" | "ocr_mode_accurate";
                                isEnabled: boolean;
                                limitPeriod: ("monthly" | "unlimited") | null;
                                limitValue: number | null;
                            }[];
                            /** Format: uuid */
                            id: string;
                            isCurrent: boolean;
                            /** Format: uuid */
                            planId: string;
                            versionNumber: number;
                        };
                    };
                };
                /** @description Default Response */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
                /** @description Default Response */
                500: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                                requestId: string;
                            };
                        };
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
}
export type webhooks = Record<string, never>;
export interface components {
    schemas: never;
    responses: never;
    parameters: never;
    requestBodies: never;
    headers: never;
    pathItems: never;
}
export type $defs = Record<string, never>;
export type operations = Record<string, never>;
