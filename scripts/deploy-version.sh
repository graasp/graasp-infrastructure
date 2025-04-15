#!/usr/bin/env bash

function show_help() {
    echo "This script allows to deploy a new version of the graasp ecs service and push the docker images for the core and the migration"
    echo "Usage: bash docker/build.sh ECR_URI VERSION"
    echo "Arguments:"
    echo "  ECR_URI      URI of the ECR in AWS, example: public.ecr.aws/qzuer78"
    echo "  VERSION      The version that is deployed, should be a semantic version i.e 1.45.8"
}

# Check if no arguments are provided
if [ "$#" -eq 0 ]; then
    show_help
    exit 1
fi

# Get inputs from command line
if [ -z "$1" ]; then
  echo "Missing required ECR_URI argument"
  exit 1
fi
private_ecr_uri=$1

if [ -z "$2" ]; then
  echo "Missing required VERSION argument"
  exit 1
fi
tag_version=$2

core_image_tag=core-$tag_version
public_ecr_image=docker://${{ vars.AWS_PUBLIC_ECR_URI }}/graasp:$core_image_tag
image_tag=docker://$private_ecr_uri/graasp:core-latest
# login
aws ecr get-login-password --region $region | skopeo login --username AWS --password-stdin $private_ecr
# copy
skopeo --override-os linux copy --multi-arch all $public_ecr_image $image_tag

aws ecs update-service --cluster graasp-dev --service graasp --force-new-deployment


# private_ecr=${{ secrets.AWS_ACCOUNT_ID }}.dkr.ecr.${{ vars.AWS_REGION }}.amazonaws.com
