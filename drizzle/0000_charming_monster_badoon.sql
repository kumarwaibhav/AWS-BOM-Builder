CREATE TYPE "public"."bill_status" AS ENUM('processing', 'completed', 'failed');--> statement-breakpoint
CREATE TABLE "bills" (
	"id" serial PRIMARY KEY NOT NULL,
	"sessionId" varchar(128) NOT NULL,
	"fileName" varchar(512) NOT NULL,
	"pdfKey" varchar(1024) NOT NULL,
	"excelKey" varchar(1024),
	"billingPeriod" varchar(128),
	"accountId" varchar(64),
	"grandTotalUsd" numeric(14, 2),
	"calculatedTotalUsd" numeric(14, 2),
	"itemCount" integer DEFAULT 0 NOT NULL,
	"status" "bill_status" DEFAULT 'processing' NOT NULL,
	"errorMessage" text,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bom_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"billId" integer NOT NULL,
	"serialNo" integer NOT NULL,
	"region" varchar(128) NOT NULL,
	"serviceCategory" varchar(128) NOT NULL,
	"serviceName" varchar(256) NOT NULL,
	"description" text NOT NULL,
	"quantity" numeric(20, 6),
	"uom" varchar(64),
	"costUsd" numeric(14, 2) NOT NULL,
	"llmEnriched" integer DEFAULT 0 NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
