CREATE TABLE "review_group_files" (
	"id" serial PRIMARY KEY NOT NULL,
	"group_id" integer NOT NULL,
	"path" text NOT NULL,
	"start_line" integer,
	"end_line" integer,
	CONSTRAINT "review_group_files_range_check" CHECK (("review_group_files"."start_line" is null and "review_group_files"."end_line" is null) or ("review_group_files"."start_line" >= 1 and "review_group_files"."end_line" >= "review_group_files"."start_line"))
);
--> statement-breakpoint
CREATE TABLE "review_group_reviews" (
	"group_id" integer NOT NULL,
	"user_id" bigint NOT NULL,
	"reviewed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "review_group_reviews_group_id_user_id_pk" PRIMARY KEY("group_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "review_groups" (
	"id" serial PRIMARY KEY NOT NULL,
	"owner" text NOT NULL,
	"repo" text NOT NULL,
	"pr_number" integer NOT NULL,
	"head_sha" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"position" integer NOT NULL,
	"source" text NOT NULL,
	"created_by" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "review_groups_source_check" CHECK ("review_groups"."source" in ('manual', 'ai'))
);
--> statement-breakpoint
CREATE TABLE "review_viewed_files" (
	"owner" text NOT NULL,
	"repo" text NOT NULL,
	"pr_number" integer NOT NULL,
	"head_sha" text NOT NULL,
	"user_id" bigint NOT NULL,
	"path" text NOT NULL,
	"viewed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "review_viewed_files_owner_repo_pr_number_user_id_head_sha_path_pk" PRIMARY KEY("owner","repo","pr_number","user_id","head_sha","path")
);
--> statement-breakpoint
ALTER TABLE "review_group_files" ADD CONSTRAINT "review_group_files_group_id_review_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."review_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_group_reviews" ADD CONSTRAINT "review_group_reviews_group_id_review_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."review_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "review_group_files_group_idx" ON "review_group_files" USING btree ("group_id");--> statement-breakpoint
CREATE INDEX "review_groups_pr_idx" ON "review_groups" USING btree ("owner","repo","pr_number","head_sha");