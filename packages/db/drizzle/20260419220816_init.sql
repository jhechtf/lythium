CREATE TABLE "pull_requests" (
	"id" serial PRIMARY KEY NOT NULL,
	"owner" text NOT NULL,
	"repo" text NOT NULL,
	"pr_number" integer NOT NULL,
	"title" text NOT NULL,
	"state" text NOT NULL,
	"head_ref" text NOT NULL,
	"base_ref" text NOT NULL,
	"html_url" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "pull_requests_owner_repo_pr_number_unique" UNIQUE("owner","repo","pr_number")
);
--> statement-breakpoint
CREATE TABLE "stack_members" (
	"id" serial PRIMARY KEY NOT NULL,
	"owner" text NOT NULL,
	"repo" text NOT NULL,
	"source_pr_number" integer NOT NULL,
	"member_pr_number" integer NOT NULL,
	"position" integer NOT NULL,
	"is_current" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stack_members_owner_repo_source_pr_number_member_pr_number_unique" UNIQUE("owner","repo","source_pr_number","member_pr_number")
);
