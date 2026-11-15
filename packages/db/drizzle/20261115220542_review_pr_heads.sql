CREATE TABLE "review_pr_heads" (
	"owner" text NOT NULL,
	"repo" text NOT NULL,
	"pr_number" integer NOT NULL,
	"head_sha" text NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "review_pr_heads_owner_repo_pr_number_pk" PRIMARY KEY("owner","repo","pr_number")
);
