CREATE TABLE `bills` (
	`id` int AUTO_INCREMENT NOT NULL,
	`sessionId` varchar(128) NOT NULL,
	`fileName` varchar(512) NOT NULL,
	`pdfKey` varchar(1024) NOT NULL,
	`excelKey` varchar(1024),
	`billingPeriod` varchar(128),
	`accountId` varchar(64),
	`grandTotalUsd` decimal(14,2),
	`calculatedTotalUsd` decimal(14,2),
	`itemCount` int NOT NULL DEFAULT 0,
	`status` enum('processing','completed','failed') NOT NULL DEFAULT 'processing',
	`errorMessage` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `bills_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `bom_items` (
	`id` int AUTO_INCREMENT NOT NULL,
	`billId` int NOT NULL,
	`serialNo` int NOT NULL,
	`region` varchar(128) NOT NULL,
	`serviceCategory` varchar(128) NOT NULL,
	`serviceName` varchar(256) NOT NULL,
	`description` text NOT NULL,
	`quantity` decimal(20,6),
	`uom` varchar(64),
	`costUsd` decimal(14,2) NOT NULL,
	`llmEnriched` int NOT NULL DEFAULT 0,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `bom_items_id` PRIMARY KEY(`id`)
);
