# MakeHijrah Relocation OS v1.0

## PROJECT_LOCK Amendment 001: Consultation Intake Fields

**Status:** Approved for implementation  
**Approved by:** Project Owner  
**Date:** 2026-07-18  
**Scope:** Public booking Step 4 only

This amendment supersedes conflicting consultation-intake field requirements in `PROJECT_LOCK.md`, `DATABASE_SCHEMA.md`, `API_CONTRACT.md`, and the frozen Lovable shell documentation.

## 1. Approved Step 4 fields

1. **Name**
   - Required.
   - Stored in the existing `consultation_intake.full_name` column.
   - This is a label change only. The database column is not renamed.

2. **Email**
   - Required.
   - Stored in `consultation_intake.email`.

3. **WhatsApp**
   - Optional.
   - Stored in `consultation_intake.phone_whatsapp`.
   - The column becomes nullable through `migration_004_optional_whatsapp.sql`.
   - The client may send `null`, an empty string normalized to `null`, or omit the value where the implementation permits.

4. **Brief summary of what you would like to talk about**
   - Required.
   - Stored in `consultation_intake.answers_jsonb` using the exact key:

```json
{
  "consultation_summary": "Client-provided summary"
}
```

## 2. Validation contract

For new consultation drafts, the frontend and orchestrator must require:

- non-empty `full_name`
- valid, non-empty `email`
- non-empty `answers.consultation_summary`

`phone_whatsapp` must not block progression or draft creation.

The orchestrator remains the final validation authority for `POST /api/consultations/draft`.

## 3. API contract amendment

The booking draft request intake object is amended to:

```json
{
  "intake": {
    "full_name": "required string",
    "email": "required valid email",
    "phone_whatsapp": "optional string or null",
    "answers": {
      "consultation_summary": "required non-empty string"
    }
  }
}
```

No other endpoint, response envelope, error code, or booking state changes.

## 4. Data-model impact

- No new table.
- No new column.
- No renamed column.
- No new route.
- No new status.
- `consultation_intake.phone_whatsapp` changes from `text not null` to nullable `text`.
- The summary uses the existing `answers_jsonb` field.

## 5. Required implementation order

1. Run `migration_004_optional_whatsapp.sql` in Supabase staging.
2. Verify `phone_whatsapp` is nullable.
3. Update Lovable mock types, Step 4 validation, textarea, and payment summary if applicable.
4. Later update the Node orchestrator request validation before connecting the real draft endpoint.

No Lovable production integration may assume WhatsApp is required after this amendment.
