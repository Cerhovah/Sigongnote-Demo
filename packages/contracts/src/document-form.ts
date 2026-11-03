import {z} from 'zod';

/** Explicit recipient-facing information. Never populate bank/stamp data from AI guesses. */
export const DocumentPartyDetailsSchema=z.strictObject({
 business_number:z.string().trim().regex(/^$|^[0-9]{3}-[0-9]{2}-[0-9]{5}$/).optional(),
 representative:z.string().trim().max(60).optional(),
 address:z.string().trim().max(180).optional(),
 business_type:z.string().trim().max(60).optional(),
 business_item:z.string().trim().max(60).optional(),
 contact:z.string().trim().max(100).optional(),
});
export const DocumentFormSchema=z.strictObject({
 issuer:DocumentPartyDetailsSchema.extend({name:z.string().trim().min(1).max(180).optional()}).optional(),
 recipient:DocumentPartyDetailsSchema.optional(),
 valid_until:z.union([z.iso.date(),z.literal('')]).optional(),
 delivery_date:z.union([z.iso.date(),z.literal('')]).optional(),
 delivery_place:z.string().trim().max(180).optional(),
 payment_terms:z.string().trim().max(180).optional(),
 payment_account:z.string().trim().max(180).optional(),
 note:z.string().trim().max(300).optional(),
});
export type DocumentForm=z.infer<typeof DocumentFormSchema>;
